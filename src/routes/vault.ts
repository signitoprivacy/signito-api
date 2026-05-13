import { Router, type IRouter } from "express";
import { db, vaultsTable, transactionsTable, vaultBalancesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  fetchVaultState,
  buildInitializeVaultIx,
  buildDepositIx,
  buildUnshieldIx,
  buildRefreshOtsIx,
  buildVersionedTx,
  deriveVaultPda,
} from "@workspace/program";
import { getConnection, relayerKeypair } from "../lib/relayer.js";

const router: IRouter = Router();

function sha256Hex(hex: string): string {
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}

function offchainSig(): string {
  return "offchain:" + randomBytes(16).toString("hex");
}

async function upsertVaultBalance(
  wallet: string,
  sToken: string,
  delta: number,
  mint?: string,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(vaultBalancesTable)
    .where(
      and(
        eq(vaultBalancesTable.wallet, wallet),
        eq(vaultBalancesTable.token, sToken),
      ),
    );

  if (existing) {
    const current = parseFloat(existing.shieldedAmount ?? "0");
    const next = Math.max(0, current + delta);
    const updates: Record<string, unknown> = { shieldedAmount: next.toFixed(9) };
    if (mint && existing.mint === "pending") updates.mint = mint;
    await db
      .update(vaultBalancesTable)
      .set(updates)
      .where(eq(vaultBalancesTable.id, existing.id));
  } else if (delta > 0) {
    await db.insert(vaultBalancesTable).values({
      wallet,
      token: sToken,
      mint: mint ?? "pending",
      shieldedAmount: delta.toFixed(9),
      decimals: 9,
    });
  }
}

const CreateVaultBody = z.object({
  wallet: z.string().min(32).max(44),
  codeHash: z.string().min(16),
  chainDepth: z.number().int().min(1).max(256).default(32),
  token: z.string().min(1).max(16).optional(),
  amount: z.number().positive().optional(),
  mint: z.string().min(32).max(44).optional(),
  stokenAccount: z.string().min(32).max(44).optional(),
  txSig: z.string().min(64).optional(),
});

const VaultDepositBody = z.object({
  wallet: z.string().min(32).max(44),
  token: z.string().min(1).max(16),
  amount: z.number().positive(),
  txSig: z.string().min(64).optional(),
});

const UnshieldBody = z.object({
  wallet: z.string().min(32).max(44),
  amount: z.number().positive(),
  destination: z.string().min(32).max(44),
  preimage: z.string().length(64),
  token: z.string().min(1).max(16).optional(),
});

const PrepareInitBody = z.object({
  wallet: z.string().min(32).max(44),
  codeHash: z.string().length(64),
  amount: z.number().positive(),
  chainDepth: z.number().int().min(1).max(256).default(32),
});

const PrepareDepositBody = z.object({
  wallet: z.string().min(32).max(44),
  amount: z.number().positive(),
});

// POST /vault/prepare-init
// Builds an initialize_vault tx with relayer as fee payer.
// Server generates fresh mintStoken + stokenAccount keypairs and partially
// signs (relayer + fresh keypairs). Client Phantom-signs then posts to /api/relay.
router.post("/vault/prepare-init", async (req, res): Promise<void> => {
  const parsed = PrepareInitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (!relayerKeypair) {
    res.status(503).json({ error: "Relayer not configured, gasless transactions unavailable" });
    return;
  }

  const { wallet, codeHash, amount, chainDepth } = parsed.data;

  try {
    const ownerPk = new PublicKey(wallet);
    const mintStokenKp = Keypair.generate();
    const stokenAtaKp = Keypair.generate();
    const otsTip = Buffer.from(codeHash, "hex");
    const amountLamports = BigInt(Math.round(amount * 1e9));

    const ix = buildInitializeVaultIx(
      ownerPk,
      mintStokenKp.publicKey,
      stokenAtaKp.publicKey,
      { otsTip, chainDepth, amount: amountLamports },
    );

    // Owner is fee payer so Phantom signs correctly (Phantom corrupts tx when fee payer != user).
    // The user pays a small gas fee; the relayer covers this via pre-funding if desired later.
    const conn = getConnection();
    const tx = await buildVersionedTx(conn, ownerPk, [ix]);
    // Sign with fresh keypairs only (owner/fee-payer signature comes from Phantom client-side)
    tx.sign([mintStokenKp, stokenAtaKp]);

    req.log.info({ wallet, chainDepth, mintStoken: mintStokenKp.publicKey.toBase58() }, "prepare-init: tx built");

    res.json({
      txBase64: Buffer.from(tx.serialize()).toString("base64"),
      mintStoken: mintStokenKp.publicKey.toBase58(),
      stokenAccount: stokenAtaKp.publicKey.toBase58(),
      chainDepth,
    });
  } catch (err) {
    req.log.error({ err }, "prepare-init error");
    res.status(500).json({ error: "Failed to build initialization transaction" });
  }
});

// POST /vault/prepare-deposit
// Builds a deposit instruction (SOL transfer + sSOL mint) with relayer as fee payer.
// Fetches mint and stokenAccount from DB. Client Phantom-signs then posts to /api/relay.
router.post("/vault/prepare-deposit", async (req, res): Promise<void> => {
  const parsed = PrepareDepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (!relayerKeypair) {
    res.status(503).json({ error: "Relayer not configured, gasless transactions unavailable" });
    return;
  }

  const { wallet, amount } = parsed.data;

  try {
    const ownerPk = new PublicKey(wallet);
    const amountLamports = BigInt(Math.round(amount * 1e9));

    // Load vault from DB to get mint and stoken account addresses.
    const [vault] = await db
      .select()
      .from(vaultsTable)
      .where(eq(vaultsTable.wallet, wallet))
      .limit(1);

    if (!vault || !vault.mint || !vault.stokenAccount) {
      res.status(404).json({ error: "Vault not found or missing token accounts. Create your vault first." });
      return;
    }

    const mintStoken = new PublicKey(vault.mint);
    const ownerStokenAta = new PublicKey(vault.stokenAccount);

    const ix = buildDepositIx(ownerPk, mintStoken, ownerStokenAta, amountLamports);

    const conn = getConnection();
    const tx = await buildVersionedTx(conn, relayerKeypair.publicKey, [ix]);
    tx.sign([relayerKeypair]);

    req.log.info({ wallet, amount, mint: vault.mint }, "prepare-deposit: deposit ix built");

    res.json({
      txBase64: Buffer.from(tx.serialize()).toString("base64"),
    });
  } catch (err) {
    req.log.error({ err }, "prepare-deposit error");
    res.status(500).json({ error: "Failed to build deposit transaction" });
  }
});

// POST /vault/create
router.post("/vault/create", async (req, res): Promise<void> => {
  const parsed = CreateVaultBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, codeHash, chainDepth, token, amount, mint, stokenAccount, txSig } = parsed.data;

  try {
    const [existing] = await db
      .select()
      .from(vaultsTable)
      .where(eq(vaultsTable.wallet, wallet));

    let created: typeof existing;

    if (existing) {
      // Re-init after close: always overwrite OTS chain state and mint addresses.
      const updates: Record<string, unknown> = { chainDepth, lastOts: codeHash };
      if (mint) updates.mint = mint;
      if (stokenAccount) updates.stokenAccount = stokenAccount;
      const [updated] = await db
        .update(vaultsTable)
        .set(updates)
        .where(eq(vaultsTable.wallet, wallet))
        .returning();
      created = updated;
      req.log.info({ wallet, chainDepth, mint: mint ?? "none", stokenAccount: stokenAccount ?? "none", txSig: txSig ?? "none" }, "Vault re-created: DB record updated");
    } else {
      const [inserted] = await db
        .insert(vaultsTable)
        .values({ wallet, chainDepth, lastOts: codeHash, mint: mint ?? null, stokenAccount: stokenAccount ?? null })
        .returning();
      created = inserted;
      req.log.info({ wallet, chainDepth, mint: mint ?? "none", stokenAccount: stokenAccount ?? "none", txSig: txSig ?? "none" }, "Vault created on-chain");
    }

    // Record initial shield deposit with real on-chain signature and mint address
    if (token && amount) {
      const sToken = "s" + token;
      const sig = txSig ?? offchainSig();
      await db.insert(transactionsTable).values({
        wallet,
        signature: sig,
        type: "shield",
        token: sToken,
        amount: amount.toFixed(9),
        status: txSig ? "confirmed" : "pending",
      });
      await upsertVaultBalance(wallet, sToken, amount, mint);
      req.log.info({ wallet, token: sToken, amount, mint: mint ?? "pending" }, "Shield deposit recorded on vault creation");
    }

    res.json({
      vault: {
        wallet: created.wallet,
        chainDepth: created.chainDepth,
        lastOts: created.lastOts ?? null,
        createdAt: created.createdAt.toISOString(),
      },
    });
  } catch (err) {
    req.log.error({ err }, "Vault create error");
    res.status(500).json({ error: "Failed to create vault" });
  }
});

// POST /vault/deposit
// Records a shield deposit for an existing vault and updates shielded balance.
router.post("/vault/deposit", async (req, res): Promise<void> => {
  const parsed = VaultDepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, token, amount, txSig } = parsed.data;

  try {
    const [vault] = await db
      .select()
      .from(vaultsTable)
      .where(eq(vaultsTable.wallet, wallet));

    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    const sToken = "s" + token;
    const sig = txSig ?? offchainSig();

    await db.insert(transactionsTable).values({
      wallet,
      signature: sig,
      type: "shield",
      token: sToken,
      amount: amount.toFixed(9),
      status: txSig ? "confirmed" : "pending",
    });

    await upsertVaultBalance(wallet, sToken, amount);

    req.log.info({ wallet, token: sToken, amount, txSig: txSig ?? "none" }, "Vault deposit recorded");

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Vault deposit error");
    res.status(500).json({ error: "Failed to record deposit" });
  }
});

// POST /vault/unshield
router.post("/vault/unshield", async (req, res): Promise<void> => {
  const parsed = UnshieldBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, amount, destination, preimage, token } = parsed.data;

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

    const computed = sha256Hex(preimage);
    if (computed !== vault.lastOts) {
      req.log.warn({ wallet, computed, tip: vault.lastOts }, "OTS pre-image mismatch");
      res.status(400).json({ error: "Invalid vault code. OTS pre-image does not match." });
      return;
    }

    const newDepth = vault.chainDepth - 1;

    await db
      .update(vaultsTable)
      .set({ lastOts: preimage, chainDepth: newDepth })
      .where(eq(vaultsTable.wallet, wallet));

    req.log.info({ wallet, destination, amount, newDepth }, "OTS verified, building unshield tx");

    // Record unshield transaction and decrement vault balance
    try {
      const sToken = token ? "s" + token : null;
      await db.insert(transactionsTable).values({
        wallet,
        signature: offchainSig(),
        type: "unshield",
        token: sToken,
        amount: amount.toFixed(9),
        status: "pending",
      });
      if (sToken) {
        await upsertVaultBalance(wallet, sToken, -amount);
      }
      req.log.info({ wallet, token: sToken, amount }, "Unshield transaction recorded");
    } catch (recordErr) {
      req.log.warn({ recordErr }, "Failed to record unshield transaction (non-fatal)");
    }

    // Build the on-chain unshield instruction.
    // owner_stoken_ata is not an ATA: use the address stored in DB at vault creation.
    let txBase64: string | null = null;
    let onchainError: string | null = null;

    try {
      const ownerPk = new PublicKey(wallet);
      const destPk = new PublicKey(destination);
      const conn = getConnection();
      const onchainVault = await fetchVaultState(conn, ownerPk);

      if (!onchainVault) {
        onchainError = "On-chain vault PDA not found. Program may not be deployed yet.";
      } else if (!vault.stokenAccount) {
        // Vault was created before stokenAccount tracking was added.
        // Return a partial success: OTS verified, but no on-chain tx can be built.
        onchainError = "sToken account not on record. This vault was created before account tracking. Unshield recorded off-chain.";
      } else {
        const ownerStokenAta = new PublicKey(vault.stokenAccount);
        const preimageBytes = Buffer.from(preimage, "hex");
        const ix = buildUnshieldIx(ownerPk, onchainVault.mintStoken, ownerStokenAta, destPk, {
          otsPreimage: new Uint8Array(preimageBytes),
          amount: BigInt(Math.round(amount * 1e9)),
        });
        const feePayer = relayerKeypair ? relayerKeypair.publicKey : ownerPk;
        const tx = await buildVersionedTx(conn, feePayer, [ix]);
        if (relayerKeypair) tx.sign([relayerKeypair]);
        txBase64 = Buffer.from(tx.serialize()).toString("base64");
      }
    } catch (txErr) {
      onchainError = txErr instanceof Error ? txErr.message : String(txErr);
      req.log.warn({ txErr }, "Unshield: on-chain tx build failed");
    }

    res.json({
      success: true,
      newChainDepth: newDepth,
      txBase64,
      onchainError,
    });
  } catch (err) {
    req.log.error({ err }, "Vault unshield error");
    res.status(500).json({ error: "Unshield failed" });
  }
});

const PrepareRefreshBody = z.object({
  wallet: z.string().min(32).max(44),
  newOtsTip: z.string().length(64),
  chainDepth: z.number().int().min(8).max(128).default(32),
});

const UpdateChainBody = z.object({
  wallet: z.string().min(32).max(44),
  chainDepth: z.number().int().min(1).max(256),
  lastOts: z.string().length(64),
  txSig: z.string().min(64).optional(),
});

// POST /vault/prepare-refresh
// Builds a refresh_ots tx with relayer as fee payer.
// Owner signs on client side then posts to /api/relay.
router.post("/vault/prepare-refresh", async (req, res): Promise<void> => {
  const parsed = PrepareRefreshBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (!relayerKeypair) {
    res.status(503).json({ error: "Relayer not configured, gasless transactions unavailable" });
    return;
  }

  const { wallet, newOtsTip, chainDepth } = parsed.data;

  try {
    const ownerPk = new PublicKey(wallet);
    const newOtsTipBytes = Buffer.from(newOtsTip, "hex");
    const ix = buildRefreshOtsIx(ownerPk, {
      newOtsTip: new Uint8Array(newOtsTipBytes),
      newChainDepth: chainDepth,
    });
    const conn = getConnection();
    const tx = await buildVersionedTx(conn, relayerKeypair.publicKey, [ix]);
    tx.sign([relayerKeypair]);
    req.log.info({ wallet, chainDepth }, "prepare-refresh: tx built");
    res.json({ txBase64: Buffer.from(tx.serialize()).toString("base64") });
  } catch (err) {
    req.log.error({ err }, "prepare-refresh error");
    res.status(500).json({ error: "Failed to build refresh transaction" });
  }
});

// POST /vault/update-chain
// Updates DB after a successful on-chain refresh_ots.
router.post("/vault/update-chain", async (req, res): Promise<void> => {
  const parsed = UpdateChainBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, chainDepth, lastOts, txSig } = parsed.data;

  try {
    const [vault] = await db.select().from(vaultsTable).where(eq(vaultsTable.wallet, wallet));
    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    await db
      .update(vaultsTable)
      .set({ chainDepth, lastOts })
      .where(eq(vaultsTable.wallet, wallet));

    req.log.info({ wallet, chainDepth, txSig: txSig ?? "none" }, "OTS chain refreshed");
    res.json({ success: true, chainDepth });
  } catch (err) {
    req.log.error({ err }, "update-chain error");
    res.status(500).json({ error: "Failed to update chain" });
  }
});

// POST /vault/:wallet/sync
// Reads on-chain vault PDA and updates DB lastOts + chainDepth to match.
// Call this when the DB is out of sync with on-chain state (e.g. after a
// manual unshield or test run that bypassed the API).
router.post("/vault/:wallet/sync", async (req, res): Promise<void> => {
  const wallet = req.params.wallet as string;
  try {
    const ownerPk = new PublicKey(wallet);
    const conn = getConnection();
    const state = await fetchVaultState(conn, ownerPk);

    if (!state) {
      res.status(404).json({ error: "On-chain vault PDA not found" });
      return;
    }

    const onchainOts = Buffer.from(state.currentOtsHash).toString("hex");
    const onchainDepth = state.chainDepth;

    const [vault] = await db.select().from(vaultsTable).where(eq(vaultsTable.wallet, wallet));
    if (!vault) {
      res.status(404).json({ error: "DB vault record not found. Register via POST /vault/create first." });
      return;
    }

    await db
      .update(vaultsTable)
      .set({ lastOts: onchainOts, chainDepth: onchainDepth })
      .where(eq(vaultsTable.wallet, wallet));

    req.log.info({ wallet, onchainDepth, onchainOts }, "vault/sync: DB synced to on-chain state");
    res.json({ success: true, chainDepth: onchainDepth, lastOts: onchainOts });
  } catch (err) {
    req.log.error({ err }, "vault/sync error");
    res.status(500).json({ error: "Sync failed" });
  }
});

// GET /vault/:wallet
router.get("/vault/:wallet", async (req, res): Promise<void> => {
  const wallet = req.params.wallet as string;

  type OnchainVault = {
    vaultPda: string;
    chainDepth: number;
    totalDeposited: string;
    mintStoken: string;
  };

  try {
    const [vault] = await db
      .select()
      .from(vaultsTable)
      .where(eq(vaultsTable.wallet, wallet));

    let onchain: OnchainVault | null = null;
    try {
      const ownerPk = new PublicKey(wallet);
      const conn = getConnection();
      const state = await fetchVaultState(conn, ownerPk);
      if (state) {
        onchain = {
          vaultPda: state.publicKey.toBase58(),
          chainDepth: state.chainDepth,
          totalDeposited: state.totalDeposited.toString(),
          mintStoken: state.mintStoken.toBase58(),
        };
      }
    } catch {
      // Non-fatal: program may not be deployed yet
    }

    if (!vault) {
      res.json({ vault: null, onchain });
      return;
    }

    res.json({
      vault: {
        wallet: vault.wallet,
        chainDepth: vault.chainDepth,
        lastOts: vault.lastOts ?? null,
        stokenAccount: vault.stokenAccount ?? null,
        mint: vault.mint ?? null,
        createdAt: vault.createdAt.toISOString(),
      },
      onchain,
    });
  } catch (err) {
    req.log.error({ err }, "Vault fetch error");
    res.json({ vault: null, onchain: null });
  }
});

// GET /vault/:wallet/pda
router.get("/vault/:wallet/pda", (req, res): void => {
  const wallet = req.params.wallet as string;
  try {
    const ownerPk = new PublicKey(wallet);
    const [pda] = deriveVaultPda(ownerPk);
    res.json({ pda: pda.toBase58(), owner: wallet });
  } catch {
    res.status(400).json({ error: "Invalid wallet address" });
  }
});

export default router;
