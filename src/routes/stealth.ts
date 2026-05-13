import { Router, type IRouter } from "express";
import { createHash } from "crypto";
import { db, stealthPendingTable, vaultsTable, vaultBalancesTable, transactionsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getConnection, relayerKeypair, relayerReady } from "../lib/relayer.js";
import { heliusRpcUrl } from "../lib/rpc.js";
import { buildVersionedTx, buildZkUnshieldIx } from "@workspace/program";

const router: IRouter = Router();

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

    const ix = SystemProgram.transfer({
      fromPubkey: relayPk,
      toPubkey: recipientPk,
      lamports: amountLamports,
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

    req.log.info({ commitment, recipient, txSig, amountSol }, "StealthSend withdrawal completed");
    res.json({ success: true, txSig });
  } catch (err) {
    req.log.error({ err }, "StealthSend withdrawal error");
    res.status(500).json({ error: "Withdrawal failed" });
  }
});

router.post("/stealth/zk-transfer", async (req, res): Promise<void> => {
  const parsed = ZkTransferBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", detail: parsed.error.message });
    return;
  }

  const { wallet, amount, recipient, token, preimage } = parsed.data;

  if (!relayerReady() || !relayerKeypair) {
    res.status(503).json({ error: "Relay not configured, ZK transfer unavailable" });
    return;
  }

  try {
    const [vault] = await db
      .select()
      .from(vaultsTable)
      .where(eq(vaultsTable.wallet, wallet));

    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    if (!vault.lastOts) {
      res.status(400).json({ error: "Vault has no OTS tip. Re-initialize." });
      return;
    }

    if (vault.chainDepth <= 0) {
      res.status(400).json({ error: "OTS chain exhausted. Vault depth is 0." });
      return;
    }

    // Off-chain pre-check: fast-fail before building the transaction.
    const computed = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    if (computed !== vault.lastOts) {
      req.log.warn({ wallet, computed, tip: vault.lastOts }, "ZK transfer: OTS pre-image mismatch");
      res.status(400).json({ error: "Invalid vault code. OTS pre-image does not match." });
      return;
    }

    const sToken = "s" + token;
    const [balanceRow] = await db
      .select()
      .from(vaultBalancesTable)
      .where(and(eq(vaultBalancesTable.wallet, wallet), eq(vaultBalancesTable.token, sToken)));

    const currentBalance = balanceRow ? parseFloat(balanceRow.shieldedAmount ?? "0") : 0;
    if (currentBalance < amount) {
      res.status(400).json({ error: `Insufficient shielded balance: have ${currentBalance.toFixed(4)}, need ${amount}` });
      return;
    }

    // Require on-chain accounts. Vaults missing mint or stokenAccount were
    // created in an older flow and cannot use zk_unshield.
    if (!vault.mint || !vault.stokenAccount) {
      res.status(400).json({
        error: "Vault missing on-chain token accounts. Close and re-initialize the vault to enable ZK transfer.",
      });
      return;
    }

    const ownerPk      = new PublicKey(wallet);
    const relayPk      = relayerKeypair.publicKey;
    const mintPk       = new PublicKey(vault.mint);
    const stokenAtaPk  = new PublicKey(vault.stokenAccount);
    const recipientPk  = new PublicKey(recipient);
    const amountLamports = BigInt(Math.round(amount * LAMPORTS_PER_SOL));

    // Build the on-chain zk_unshield instruction.
    // This burns sSOL on-chain via vault PDA delegate authority and sends SOL
    // from the vault PDA to the recipient. The owner wallet does NOT sign.
    const ix = buildZkUnshieldIx(
      relayPk,
      ownerPk,
      mintPk,
      stokenAtaPk,
      recipientPk,
      { otsPreimage: Buffer.from(preimage, "hex"), amount: amountLamports },
    );

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
      req.log.error({ err: rpcData.error }, "ZK transfer broadcast failed");
      res.status(400).json({ error: rpcData.error?.message ?? "Broadcast failed" });
      return;
    }

    const txSig = rpcData.result;

    // Update DB after confirmed on-chain broadcast.
    // The on-chain instruction is the authoritative source:
    //   - sSOL burned on-chain by vault PDA delegate
    //   - OTS chain advanced on-chain
    //   - SOL sent from vault PDA to recipient on-chain
    // The DB update here mirrors the on-chain state for fast UI reads.
    const newDepth = vault.chainDepth - 1;
    await db
      .update(vaultsTable)
      .set({ lastOts: preimage, chainDepth: newDepth })
      .where(eq(vaultsTable.wallet, wallet));

    const newBalance = Math.max(0, currentBalance - amount);
    if (balanceRow) {
      await db
        .update(vaultBalancesTable)
        .set({ shieldedAmount: newBalance.toFixed(9) })
        .where(eq(vaultBalancesTable.id, balanceRow.id));
    }

    await db.insert(transactionsTable).values({
      wallet,
      signature: txSig,
      type: "zk-transfer",
      token: sToken,
      amount: amount.toFixed(9),
      status: "confirmed",
    });

    req.log.info({ wallet, recipient, txSig, amount, token: sToken, newDepth }, "ZK transfer completed: sSOL burned on-chain");
    res.json({ success: true, txSig });
  } catch (err) {
    req.log.error({ err }, "ZK transfer error");
    res.status(500).json({ error: "ZK transfer failed" });
  }
});

export default router;
