import { Router, type IRouter } from "express";
import { createHash, randomBytes } from "crypto";
import { db, stealthPendingTable, vaultsTable, vaultBalancesTable, transactionsTable, mixWalletsTable } from "@workspace/db";
import { eq, and, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getConnection, relayerKeypair, relayerReady } from "../lib/relayer.js";
import { heliusRpcUrl } from "../lib/rpc.js";
import {
  buildVersionedTx,
  buildPrivateSendIx,
  buildFundFreshRelayerIx,
  buildBurnAndQueueIx,
  buildProcessQueueIx,
  fetchUserState,
} from "@workspace/program";

const router: IRouter = Router();

const SIM_MODE = process.env.SIM_MODE === "true";

// Number of decoy accounts to burn alongside real zk-transfer burns.
// Mirrors vault.ts unshield decoys for consistent anonymity set.
// Set to 0 until on-chain program is upgraded with decoy_burn instruction.
const MIX_ZK_DECOYS = Number(process.env.MIX_ZK_DECOYS ?? "20");


// Pick available decoy accounts and atomically mark them in_use.
async function pickAndReserveDecoys(count: number): Promise<Array<{ id: number; stokenAta: string }>> {
  if (count <= 0) return [];
  try {
    const available = await db
      .select({ id: mixWalletsTable.id, stokenAta: mixWalletsTable.stokenAta })
      .from(mixWalletsTable)
      .where(eq(mixWalletsTable.status, "available"))
      .limit(count);
    if (available.length === 0) return [];
    const ids = available.map((r) => r.id);
    await db
      .update(mixWalletsTable)
      .set({ status: "in_use", lastUsedAt: new Date() })
      .where(sql`id = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::int[])`);
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]] as [typeof available[0], typeof available[0]];
    }
    return available;
  } catch {
    return [];
  }
}

async function markDecoysDepeleted(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await db
      .update(mixWalletsTable)
      .set({ status: "depleted", lastUsedAt: new Date() })
      .where(sql`id = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::int[])`);
  } catch { /* non-fatal */ }
}

async function releaseDecoys(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await db
      .update(mixWalletsTable)
      .set({ status: "available" })
      .where(sql`id = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::int[])`);
  } catch { /* non-fatal */ }
}

function simSig(): string {
  return "sim:" + randomBytes(32).toString("hex");
}

async function upsertStealthBalance(wallet: string, sToken: string, delta: number): Promise<void> {
  const [existing] = await db.select().from(vaultBalancesTable).where(and(eq(vaultBalancesTable.wallet, wallet), eq(vaultBalancesTable.token, sToken)));
  if (existing) {
    const next = Math.max(0, parseFloat(existing.shieldedAmount ?? "0") + delta);
    await db.update(vaultBalancesTable).set({ shieldedAmount: next.toFixed(9) }).where(eq(vaultBalancesTable.wallet, wallet));
  }
}

const StealthDepositBody = z.object({
  wallet: z.string().min(32).max(44),
  commitment: z.string().length(64),
  amount: z.number().positive().max(100),
  token: z.string().min(1).max(16),
  depositTxSig: z.string().min(64).max(128),
});

const StealthWithdrawBody = z.object({
  nullifier: z.string().length(64),
  recipient: z.string().min(32).max(44),
});

const ZkTransferBody = z.object({
  wallet: z.string().min(32).max(44),
  amount: z.number().positive().max(100),
  recipient: z.string().min(32).max(44),
  token: z.string().min(1).max(16),
  preimage: z.string().length(64),
});

router.get("/stealth-pending/:wallet", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.wallet) ? req.params.wallet[0] : req.params.wallet;
  const wallet = raw as string;

  try {
    const rows = await db
      .select()
      .from(stealthPendingTable)
      .where(eq(stealthPendingTable.wallet, wallet))
      .orderBy(stealthPendingTable.createdAt);

    const pending = rows.map((r) => ({
      id: r.id,
      commitment: r.commitment,
      nullifier: r.nullifier ?? null,
      amount: r.amount != null ? parseFloat(r.amount) : null,
      token: r.token ?? null,
      createdAt: r.createdAt.toISOString(),
    }));

    res.json({ pending });
  } catch (err) {
    req.log.error({ err }, "Stealth pending fetch error");
    res.json({ pending: [] });
  }
});

router.post("/stealth/deposit", async (req, res): Promise<void> => {
  const parsed = StealthDepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", detail: parsed.error.message });
    return;
  }

  const { wallet, commitment, amount, token, depositTxSig } = parsed.data;

  if (!relayerReady() || !relayerKeypair) {
    res.status(503).json({ error: "Relay not configured, StealthSend deposit unavailable" });
    return;
  }

  try {
    const conn = getConnection();

    const txInfo = await conn.getTransaction(depositTxSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!txInfo) {
      res.status(400).json({ error: "Transaction not found or not confirmed on-chain" });
      return;
    }

    if (txInfo.meta?.err) {
      res.status(400).json({ error: "Transaction failed on-chain" });
      return;
    }

    const relayPubkeyStr = relayerKeypair.publicKey.toBase58();
    const message = txInfo.transaction.message;
    const accountKeys =
      "staticAccountKeys" in message
        ? (message as unknown as { staticAccountKeys: PublicKey[] }).staticAccountKeys
        : (message as unknown as { accountKeys: PublicKey[] }).accountKeys;

    const relayIndex = accountKeys.findIndex((k) => k.toBase58() === relayPubkeyStr);
    if (relayIndex === -1) {
      res.status(400).json({ error: "Relay wallet not found in transaction accounts" });
      return;
    }

    const preBalances = txInfo.meta?.preBalances ?? [];
    const postBalances = txInfo.meta?.postBalances ?? [];
    const relayReceived = (postBalances[relayIndex] ?? 0) - (preBalances[relayIndex] ?? 0);
    const expectedLamports = Math.round(amount * LAMPORTS_PER_SOL);

    if (relayReceived < Math.round(expectedLamports * 0.99)) {
      res.status(400).json({
        error: `Relay received ${relayReceived} lamports, expected ~${expectedLamports}`,
      });
      return;
    }

    const [existing] = await db
      .select()
      .from(stealthPendingTable)
      .where(eq(stealthPendingTable.commitment, commitment));

    if (existing) {
      res.status(400).json({ error: "Commitment already registered" });
      return;
    }

    const [row] = await db
      .insert(stealthPendingTable)
      .values({
        wallet,
        commitment,
        amount: amount.toFixed(9),
        token,
        depositTxSig,
      })
      .returning();

    req.log.info({ wallet, commitment, amount, depositTxSig }, "StealthSend deposit registered");
    res.json({ success: true, depositId: row?.id ?? 0 });
  } catch (err) {
    req.log.error({ err }, "StealthSend deposit error");
    res.status(500).json({ error: "Failed to register deposit" });
  }
});

router.post("/stealth/withdraw", async (req, res): Promise<void> => {
  const parsed = StealthWithdrawBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", detail: parsed.error.message });
    return;
  }

  const { nullifier, recipient } = parsed.data;

  if (!relayerReady() || !relayerKeypair) {
    res.status(503).json({ error: "Relay not configured, StealthSend withdrawal unavailable" });
    return;
  }

  const commitment = createHash("sha256").update(Buffer.from(nullifier, "hex")).digest("hex");

  try {
    const [row] = await db
      .select()
      .from(stealthPendingTable)
      .where(
        and(
          eq(stealthPendingTable.commitment, commitment),
          isNull(stealthPendingTable.nullifier),
        ),
      );

    if (!row) {
      res.status(404).json({ error: "No matching unspent deposit found for this nullifier" });
      return;
    }

    const amountSol = row.amount != null ? parseFloat(row.amount) : 0;
    if (amountSol <= 0) {
      res.status(400).json({ error: "Deposit has zero or invalid amount" });
      return;
    }

    const recipientPk = new PublicKey(recipient);
    const relayPk = relayerKeypair.publicKey;
    const amountLamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));

    // 0.15% protocol fee stays in relayer wallet; recipient receives net amount
    const feeLamports = BigInt(Math.round(amountSol * 0.0015 * LAMPORTS_PER_SOL));
    const netLamports = amountLamports - feeLamports;

    const ix = SystemProgram.transfer({
      fromPubkey: relayPk,
      toPubkey: recipientPk,
      lamports: netLamports,
    });

    const conn = getConnection();
    const tx = await buildVersionedTx(conn, relayPk, [ix]);
    tx.sign([relayerKeypair]);

    const rawBase64 = Buffer.from(tx.serialize()).toString("base64");
    const url = heliusRpcUrl();

    const rpcRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "sendTransaction",
        params: [rawBase64, { encoding: "base64", preflightCommitment: "confirmed" }],
        id: 1,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const rpcData = (await rpcRes.json()) as { result?: string; error?: { message: string } };

    if (rpcData.error || !rpcData.result) {
      req.log.error({ err: rpcData.error }, "StealthSend withdrawal broadcast failed");
      res.status(400).json({ error: rpcData.error?.message ?? "Broadcast failed" });
      return;
    }

    const txSig = rpcData.result;

    await db
      .update(stealthPendingTable)
      .set({ nullifier, withdrawTxSig: txSig })
      .where(eq(stealthPendingTable.id, row.id));

    req.log.info({ commitment, recipient, txSig, amountSol, feeLamports: feeLamports.toString(), netLamports: netLamports.toString() }, "StealthSend withdrawal completed");
    res.json({ success: true, txSig });
  } catch (err) {
    req.log.error({ err }, "StealthSend withdrawal error");
    res.status(500).json({ error: "Withdrawal failed" });
  }
});

// POST /stealth/zk-transfer
// Privacy-preserving private_send: burns sSOL from pool, sends SOL to recipient.
// Owner wallet does NOT appear in the transaction -- privacy guarantee.
// The relayer uses the user's stoken_ata (random address, not wallet-derived).

router.post("/stealth/zk-transfer", async (req, res): Promise<void> => {
  const parsed = ZkTransferBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", detail: parsed.error.message });
    return;
  }

  const { wallet, amount, recipient, token, preimage } = parsed.data;

  try {
    const [vault] = await db
      .select()
      .from(vaultsTable)
      .where(eq(vaultsTable.wallet, wallet));

    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    if (SIM_MODE) {
      const sToken = "s" + token;
      const computed = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
      if (computed !== vault.lastOts) {
        res.status(400).json({ error: "Vault code incorrect or wrong step." });
        return;
      }
      const [balanceRow] = await db.select().from(vaultBalancesTable).where(and(eq(vaultBalancesTable.wallet, wallet), eq(vaultBalancesTable.token, sToken)));
      const currentBalance = balanceRow ? parseFloat(balanceRow.shieldedAmount ?? "0") : 0;
      if (currentBalance < amount) {
        res.status(400).json({ error: `Insufficient shielded balance: have ${currentBalance.toFixed(4)}, need ${amount}` });
        return;
      }
      const newDepth = Math.max(0, (vault.chainDepth ?? 1) - 1);
      const txSig = simSig();
      try {
        await db.update(vaultsTable).set({ lastOts: preimage, chainDepth: newDepth }).where(eq(vaultsTable.wallet, wallet));
        await db.insert(transactionsTable).values({ wallet, signature: txSig, type: "zk-transfer", token: sToken, amount: amount.toFixed(9), status: "confirmed" });
        await upsertStealthBalance(wallet, sToken, -amount);
      } catch (dbErr) {
        req.log.warn({ dbErr }, "zk-transfer sim: DB update failed");
      }
      req.log.info({ wallet, amount, recipient, newDepth }, "zk-transfer: sim mode completed");
      res.json({ success: true, txSig, newChainDepth: newDepth, sim: true });
      return;
    }

    if (!relayerReady() || !relayerKeypair) {
      res.status(503).json({ error: "Relay not configured, ZK transfer unavailable" });
      return;
    }

    // Pre-flight: relayer must have enough SOL to cover both TX fees + rent-exempt minimum.
    // Minimum = rent-exempt (890_880) + TX1 fee (~25_000) + TX2 fee (~25_000) + margin.
    // Reject early so sSOL is never burned if TX2 would fail due to low relayer balance.
    const RELAYER_MIN_LAMPORTS = 10_000_000; // 0.01 SOL safety threshold
    const relayerBalance = await getConnection().getBalance(relayerKeypair.publicKey, "confirmed");
    if (relayerBalance < RELAYER_MIN_LAMPORTS) {
      req.log.error({ relayerBalance, threshold: RELAYER_MIN_LAMPORTS }, "ZK transfer rejected: relayer balance too low");
      res.status(503).json({ error: "Relay temporarily unavailable, please try again shortly." });
      return;
    }

    if (!vault.stokenAccount || !vault.mint) {
      res.status(400).json({ error: "Vault missing on-chain token accounts. Close and re-shield to enable private send." });
      return;
    }

    // Verify against on-chain state (source of truth), not DB -- DB may be stale after failed txs
    const conn = getConnection();
    const stokenAtaPk = new PublicKey(vault.stokenAccount);
    const onchainState = await fetchUserState(conn, stokenAtaPk);

    if (!onchainState) {
      res.status(400).json({ error: "On-chain vault not found. Re-shield first." });
      return;
    }

    if (onchainState.chainDepth <= 0) {
      res.status(400).json({ error: "OTS chain exhausted on-chain. Refresh first." });
      return;
    }

    const onchainTip = Buffer.from(onchainState.currentOtsHash).toString("hex");
    const computed = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");

    if (computed !== onchainTip) {
      // Sync DB to on-chain so future attempts use correct state
      await db
        .update(vaultsTable)
        .set({ lastOts: onchainTip, chainDepth: onchainState.chainDepth })
        .where(eq(vaultsTable.wallet, wallet));
      req.log.warn({ wallet, computed, onchainTip, dbTip: vault.lastOts, onchainDepth: onchainState.chainDepth }, "ZK transfer: OTS mismatch vs on-chain, DB re-synced");
      res.status(400).json({ error: "Vault code incorrect or wrong step. Vault state re-synced, try again." });
      return;
    }

    const sToken = "s" + token;

    // Use on-chain deposited amount as the source of truth for balance.
    // vault_balances is only updated in SIM mode; on-chain state is always accurate.
    const onchainBalance = Number(onchainState.deposited) / LAMPORTS_PER_SOL;
    if (onchainBalance < amount) {
      res.status(400).json({ error: `Insufficient shielded balance: have ${onchainBalance.toFixed(4)} SOL on-chain, need ${amount}` });
      return;
    }

    const relayPk = relayerKeypair.publicKey;
    const mintPk = new PublicKey(vault.mint);
    const recipientPk = new PublicKey(recipient);
    const amountLamports = BigInt(Math.round(amount * LAMPORTS_PER_SOL));
    const url = heliusRpcUrl();

    // Helper: broadcast a signed versioned transaction and return the signature
    async function broadcastTx(tx: VersionedTransaction): Promise<string> {
      const rawBase64 = Buffer.from(tx.serialize()).toString("base64");
      const rpcRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "sendTransaction",
          params: [rawBase64, { encoding: "base64", preflightCommitment: "confirmed" }],
          id: 1,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const rpcData = (await rpcRes.json()) as { result?: string; error?: { message: string } };
      if (rpcData.error || !rpcData.result) throw new Error(rpcData.error?.message ?? "Broadcast failed");
      return rpcData.result;
    }

    // Helper: confirm a transaction by polling until confirmed or timeout.
    // Each poll attempt retries up to 3 times on transient network errors
    // (ECONNRESET, timeout) before counting as a failed attempt.
    async function confirmTx(sig: string, maxAttempts = 20): Promise<void> {
      for (let i = 0; i < maxAttempts; i++) {
        let status: { confirmationStatus?: string; err?: unknown } | null | undefined;
        let fetchOk = false;

        for (let retry = 0; retry < 3; retry++) {
          try {
            const statusRes = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                method: "getSignatureStatuses",
                params: [[sig], { searchTransactionHistory: true }],
                id: 1,
              }),
              signal: AbortSignal.timeout(12000),
            });
            const statusData = (await statusRes.json()) as {
              result?: { value: Array<{ confirmationStatus?: string; err?: unknown } | null> };
            };
            status = statusData.result?.value?.[0];
            fetchOk = true;
            break;
          } catch (fetchErr) {
            const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            req.log.warn({ sig, attempt: i, retry, msg }, "confirmTx: fetch error, retrying");
            await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
          }
        }

        if (!fetchOk) {
          // All retries failed for this poll attempt, wait and try again next iteration
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        if (status?.err) throw new Error("Transaction failed on-chain: " + JSON.stringify(status.err));
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error("Transaction confirmation timeout");
    }

    // 2-TX StealthSend flow:
    // TX1: [fund_fresh_relayer, burn_and_queue] signed by relayer + freshWallet
    //   - fund_fresh_relayer: FunderPDA -> freshWallet (gas for TX1)
    //   - burn_and_queue: freshWallet signs, burns sSOL -- NO recipient on-chain
    // TX2: process_queue signed by relayer alone
    //   - pool_pda -> recipient (NO link to TX1 on-chain)
    // Zero common accounts between TX1 and TX2.

    const GAS_LAMPORTS = BigInt(1_000_000); // rent exempt (890_880) + tx fee margin
    const freshWallet = Keypair.generate();
    const freshPk = freshWallet.publicKey;

    req.log.info({ wallet, freshWallet: freshPk.toBase58() }, "ZK 2TX: fresh wallet generated");

    // Mix layer: pick decoy ATAs and pass them as remaining_accounts directly
    // into burn_and_queue. All N+1 burns (real + decoys) execute inside the SAME
    // instruction, appearing as one "Interact" block in the block explorer.
    // TX layout: fundIx + burnIx (2 instructions). ~1186 raw bytes with 20 decoys.
    const decoyRows = await pickAndReserveDecoys(MIX_ZK_DECOYS);
    let decoyIds = decoyRows.map((r) => r.id);
    let decoyAtaPks = decoyRows.map((r) => new PublicKey(r.stokenAta));

    // Validate decoy accounts exist on-chain before including in burn TX.
    // Prevents InvalidAccountData if a decoy_shield TX was dropped and the
    // account never actually landed on Solana.
    if (decoyAtaPks.length > 0) {
      const infos = await conn.getMultipleAccountsInfo(decoyAtaPks).catch(() => null);
      if (infos) {
        const invalidIds = decoyIds.filter((_, i) => infos[i] === null);
        if (invalidIds.length > 0) {
          req.log.warn({ invalidCount: invalidIds.length, total: decoyAtaPks.length }, "zk-transfer: dropping non-existent decoy accounts, marking depleted");
          await markDecoysDepeleted(invalidIds);
          decoyAtaPks = decoyAtaPks.filter((_, i) => infos[i] !== null);
          decoyIds = decoyIds.filter((_, i) => infos[i] !== null);
        }
      }
    }

    const fundIx = buildFundFreshRelayerIx(relayPk, freshPk, GAS_LAMPORTS);
    const burnIx = buildBurnAndQueueIx(
      freshPk,
      mintPk,
      stokenAtaPk,
      { otsPreimage: Buffer.from(preimage, "hex"), amount: amountLamports },
      decoyAtaPks,
    );

    req.log.info({ wallet, decoyCount: decoyRows.length }, "ZK 1TX: real burn + " + decoyRows.length + " decoy burns in same instruction");
    const tx1Ixs = [fundIx, burnIx];

    let tx1Sig: string;
    try {
      const tx1 = await buildVersionedTx(conn, relayPk, tx1Ixs);
      tx1.sign([relayerKeypair, freshWallet]);
      tx1Sig = await broadcastTx(tx1);
    } catch (txErr) {
      const msg = txErr instanceof Error ? txErr.message : String(txErr);
      req.log.warn({ txErr }, "ZK 1TX: burn_and_queue failed");
      await releaseDecoys(decoyIds);
      res.status(400).json({ error: `On-chain burn failed: ${msg}` });
      return;
    }
    req.log.info({ tx1Sig, freshWallet: freshPk.toBase58() }, "ZK 1TX: burn broadcast (burn_and_queue)");

    await confirmTx(tx1Sig);
    req.log.info({ tx1Sig }, "ZK 2TX: TX1 confirmed");
    await markDecoysDepeleted(decoyIds);

    // TX2: process_queue (relayer only, recipient appears here only)
    const processIx = buildProcessQueueIx(relayPk, recipientPk, amountLamports);
    const tx2 = await buildVersionedTx(conn, relayPk, [processIx]);
    tx2.sign([relayerKeypair]);
    const tx2Sig = await broadcastTx(tx2);
    req.log.info({ tx2Sig, recipient }, "ZK 2TX: TX2 broadcast (process_queue)");

    await confirmTx(tx2Sig);
    req.log.info({ tx2Sig, recipient, amount }, "ZK 2TX: TX2 confirmed, SOL delivered to recipient");

    // Best-effort: return any remaining SOL from freshWallet to FunderPDA
    // Fire-and-forget -- do not await, do not let failure block the response
    void (async () => {
      try {
        const freshBalance = await conn.getBalance(freshPk, "confirmed");
        if (freshBalance > 5000) {
          const returnLamports = freshBalance - 5000;
          const { blockhash } = await conn.getLatestBlockhash("confirmed");
          const returnMsg = new TransactionMessage({
            payerKey: freshPk,
            recentBlockhash: blockhash,
            instructions: [
              SystemProgram.transfer({
                fromPubkey: freshPk,
                toPubkey: new PublicKey("EvdRpV1Vn5qGmxnqHS3NVQgo341kvRqXsU1WCYUwqhHg"),
                lamports: BigInt(returnLamports),
              }),
            ],
          }).compileToV0Message();
          const returnTx = new VersionedTransaction(returnMsg);
          returnTx.sign([freshWallet]);
          await broadcastTx(returnTx);
          req.log.info({ returnLamports, freshWallet: freshPk.toBase58() }, "ZK 2TX: freshWallet SOL returned to FunderPDA");
        }
      } catch (returnErr) {
        req.log.warn({ returnErr }, "ZK 2TX: freshWallet SOL return failed (non-critical)");
      }
    })();

    const txSig = tx2Sig;
    const newDepth = onchainState.chainDepth - 1;
    await db
      .update(vaultsTable)
      .set({ lastOts: preimage, chainDepth: newDepth })
      .where(eq(vaultsTable.wallet, wallet));

    // On-chain UserState.deposited is the source of truth (decremented by burn_and_queue).
    // Also update DB balance row so vault_balances fallback path stays consistent.
    await upsertStealthBalance(wallet, sToken, -amount);

    await db.insert(transactionsTable).values({
      wallet,
      signature: txSig,
      type: "zk-transfer",
      token: sToken,
      amount: amount.toFixed(9),
      status: "confirmed",
    });

    req.log.info({ wallet, recipient, tx1Sig, txSig, amount, token: sToken, newDepth }, "ZK 2TX: StealthSend complete, sSOL burned TX1, SOL delivered TX2");
    res.json({ success: true, txSig, tx1Sig });
  } catch (err) {
    req.log.error({ err }, "ZK transfer error");
    res.status(500).json({ error: "ZK transfer failed" });
  }
});

export default router;
