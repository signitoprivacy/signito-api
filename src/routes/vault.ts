import { Router, type IRouter } from "express";
import { db, vaultsTable, transactionsTable, vaultBalancesTable, pendingShieldsTable, pendingDepositsTable, mixWalletsTable } from "@workspace/db";
import { eq, and, lt, sql } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, VersionedTransaction } from "@solana/web3.js";
import {
  buildShieldIx,
  buildDepositIx,
  buildRefreshOtsIx,
  buildCloseAccountIx,
  buildFundFreshRelayerIx,
  buildBurnAndQueueIx,
  buildProcessQueueIx,
  buildDecoyShieldIx,
  buildVersionedTx,
  derivePoolPda,
  deriveUserStatePda,
  fetchPoolState,
  fetchUserState,
} from "@workspace/program";
import { getConnection, relayerKeypair } from "../lib/relayer.js";
import { getSolPriceUsd } from "../lib/sol-price.js";
import { logger } from "../lib/logger.js";

// Number of decoy accounts to include alongside real shield/unshield TXs.
// Shield decoys: limited to 2 to keep TX size under 1232 bytes (each needs a signer).
// Unshield decoys: up to 20 via remaining_accounts (much more TX-size efficient).
const MIX_SHIELD_DECOYS = Number(process.env.MIX_SHIELD_DECOYS ?? "20");

// In-memory store for recently completed deposit-watcher executions.
// Keyed by pendingId, value is the broadcast txSig.
// Entries expire after 10 minutes so confirm-deposit can still return success
// even when the deposit-watcher beat the browser to the DB row.
const completedByWatcher = new Map<string, { txSig: string; expiresAt: number }>();
function storeWatcherCompletion(pendingId: string, txSig: string): void {
  completedByWatcher.set(pendingId, { txSig, expiresAt: Date.now() + 10 * 60 * 1000 });
}
function getWatcherCompletion(pendingId: string): string | null {
  const entry = completedByWatcher.get(pendingId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { completedByWatcher.delete(pendingId); return null; }
  return entry.txSig;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of completedByWatcher) {
    if (entry.expiresAt < now) completedByWatcher.delete(id);
  }
}, 60_000);
const MIX_UNSHIELD_DECOYS = Number(process.env.MIX_UNSHIELD_DECOYS ?? "20");

// Pick "ready" keypairs from pool for shield decoys (atomically reserve them).
// Returns rows with secretKey so the caller can sign decoy_shield TX.
// Falls back to empty array if pool is empty (mix layer is non-fatal).
async function pickAndReserveReadyKeypairs(count: number): Promise<Array<{ id: number; stokenAta: string; secretKey: string | null; displayOwner: string; displayOwnerSecret: string | null }>> {
  if (count <= 0) return [];
  try {
    const rows = await db
      .select({ id: mixWalletsTable.id, stokenAta: mixWalletsTable.stokenAta, secretKey: mixWalletsTable.secretKey, displayOwner: mixWalletsTable.displayOwner, displayOwnerSecret: mixWalletsTable.displayOwnerSecret })
      .from(mixWalletsTable)
      .where(eq(mixWalletsTable.status, "ready"))
      .limit(count);

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    await db
      .update(mixWalletsTable)
      .set({ status: "in_use", lastUsedAt: new Date() })
      .where(sql`id = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::int[])`);

    return rows;
  } catch {
    return [];
  }
}

// Pick available decoy accounts for decoy_burn and atomically reserve them.
// Returns the selected rows; caller must mark depleted after TX confirms.
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

    // Shuffle so real burn cannot be position-correlated
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
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
  } catch {
    // Non-fatal
  }
}

async function releaseDecoys(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await db
      .update(mixWalletsTable)
      .set({ status: "available" })
      .where(sql`id = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::int[])`);
  } catch {
    // Non-fatal
  }
}

// Fisher-Yates shuffle (used for decoy shield ordering)
function shuffleArray<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const router: IRouter = Router();

const SIM_MODE = process.env.SIM_MODE === "true";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Block well-known Solana program addresses from being used as user wallets.
// System Program is the most common test/abuse vector; block it at schema level
// to prevent orphaned DB records (DoS via pending-shield flooding).
const BLOCKED_SOLANA_ADDRESSES = new Set([
  "11111111111111111111111111111111", // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv", // Associated Token Account Program
]);
const solanaWalletField = z
  .string()
  .min(32)
  .max(44)
  .refine((w) => !BLOCKED_SOLANA_ADDRESSES.has(w), { message: "Invalid wallet address" });

function sha256Hex(hex: string): string {
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}

function offchainSig(): string {
  return "offchain:" + randomBytes(16).toString("hex");
}

function simSig(): string {
  return "sim:" + randomBytes(32).toString("hex");
}

function pendingId(): string {
  return randomBytes(16).toString("hex");
}

function encodeKeypair(kp: Keypair): string {
  return Buffer.from(kp.secretKey).toString("base64");
}

function decodeKeypair(b64: string): Keypair {
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"));
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

// ─── Pending state ────────────────────────────────────────────────────────────
// Both pendingShields and pendingDeposits are persisted to DB so keypairs
// survive server restarts and can be used for auto-refund on any failure path.

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Auto-refund: drain freshWallet back to user wallet. Relayer pays the tx fee.
// Logs but never throws -- called from error paths.
async function autoRefundSol(
  conn: ReturnType<typeof getConnection>,
  fromKp: Keypair,
  toWallet: string,
  label: string,
): Promise<void> {
  if (!relayerKeypair) return;
  try {
    const balance = await conn.getBalance(fromKp.publicKey, "confirmed");
    if (balance <= 0) return;
    const toPk = new PublicKey(toWallet);
    const refundIx = SystemProgram.transfer({
      fromPubkey: fromKp.publicKey,
      toPubkey: toPk,
      lamports: balance,
    });
    const tx = await buildVersionedTx(conn, relayerKeypair.publicKey, [refundIx]);
    tx.sign([relayerKeypair, fromKp]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
    logger.info({ label, from: fromKp.publicKey.toBase58(), to: toWallet, lamports: balance, sig }, "auto-refund: SOL returned to user");
  } catch (err) {
    logger.warn({ err, label, from: fromKp.publicKey.toBase58(), to: toWallet }, "auto-refund: failed (non-fatal)");
  }
}

// Reconstruct PendingShield from DB row — decode stored keypairs back to Keypair objects.
interface PendingShield {
  freshWallet: Keypair;
  stokenAtaKp: Keypair;
  mintStoken: string;
  poolPda: string;
  codeHash: string;
  chainDepth: number;
  amountLamports: bigint;
  rentExtra: bigint;
  expiresAt: number;
}

async function getPendingShield(id: string): Promise<PendingShield | null> {
  const [row] = await db.select().from(pendingShieldsTable).where(eq(pendingShieldsTable.pendingId, id));
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.delete(pendingShieldsTable).where(eq(pendingShieldsTable.pendingId, id));
    return null;
  }
  return {
    freshWallet: decodeKeypair(row.freshWalletKeypair),
    stokenAtaKp: decodeKeypair(row.stokenAtaKeypair),
    mintStoken: row.mintStoken,
    poolPda: row.poolPda,
    codeHash: row.codeHash,
    chainDepth: row.chainDepth,
    amountLamports: BigInt(row.amountLamports),
    rentExtra: BigInt(row.rentExtra),
    expiresAt: new Date(row.expiresAt).getTime(),
  };
}

async function deletePendingShield(id: string): Promise<void> {
  await db.delete(pendingShieldsTable).where(eq(pendingShieldsTable.pendingId, id));
}

function prunePending() {
  const now = new Date();
  // Auto-refund and prune expired DB deposit rows (fire-and-forget)
  void (async () => {
    try {
      const expired = await db
        .select()
        .from(pendingDepositsTable)
        .where(lt(pendingDepositsTable.expiresAt, now));
      for (const row of expired) {
        const fromKp = decodeKeypair(row.freshDepositWalletKeypair);
        const conn = getConnection();
        await autoRefundSol(conn, fromKp, row.wallet, "prune-expired-deposit");
        await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.pendingId, row.pendingId));
      }
    } catch {
      // non-fatal
    }
  })();
  // Prune expired DB shield rows (fire-and-forget)
  db.delete(pendingShieldsTable).where(lt(pendingShieldsTable.expiresAt, now)).catch(() => {});
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const PrepareShieldBody = z.object({
  wallet: solanaWalletField,
  codeHash: z.string().length(64),
  amount: z.number().positive(),
  chainDepth: z.number().int().min(1).max(256).default(32),
});

const ConfirmShieldBody = z.object({
  pendingId: z.string().length(32),
  wallet: solanaWalletField,
  transferSig: z.string().min(64).optional(),
});

const PrepareDepositBody = z.object({
  wallet: solanaWalletField,
  amount: z.number().positive(),
});

const ConfirmDepositBody = z.object({
  pendingId: z.string().length(32),
  wallet: solanaWalletField,
  transferSig: z.string().min(64).optional(),
});

const PrivateSendBody = z.object({
  wallet: solanaWalletField,
  amount: z.number().positive(),
  destination: solanaWalletField,
  preimage: z.string().length(64),
  token: z.string().min(1).max(16).optional(),
  stokenAccount: z.string().min(32).max(44).optional(),
});

const PrepareRefreshBody = z.object({
  wallet: solanaWalletField,
  newOtsTip: z.string().length(64),
  // otsPreimage: current vault code's preimage -- authenticates the change server-side.
  // Required when an on-chain vault exists. Mirrors the Base refreshOts on-chain check.
  otsPreimage: z.string().length(64).optional(),
  chainDepth: z.number().int().min(8).max(128).default(32),
});

const UpdateChainBody = z.object({
  wallet: z.string().min(32).max(44),
  chainDepth: z.number().int().min(1).max(256),
  lastOts: z.string().length(64),
  txSig: z.string().min(64).optional(),
});

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

// ─── GET /vault/pool ──────────────────────────────────────────────────────────

router.get("/vault/pool", async (req, res): Promise<void> => {
  const [poolPda] = derivePoolPda();

  let mintStoken: string | null = null;
  try {
    const conn = getConnection();
    const state = await fetchPoolState(conn);
    if (state) mintStoken = state.mintStoken.toBase58();
  } catch {
    // Non-fatal: program may not be deployed yet
  }

  res.json({
    poolPda: poolPda.toBase58(),
    mintStoken,
  });
});

// ─── POST /vault/prepare-shield ───────────────────────────────────────────────
// TWO-ACTOR DESIGN:
// Generates freshWallet + stokenAtaKp server-side. Builds a plain
// SystemProgram.transfer(userWallet -> freshWallet, amount + rentExtra) for
// the user to sign. No program instruction in this tx = no Phantom warning.
// Stores everything in pendingShields (TTL 10 min) keyed by pendingId.

router.post("/vault/prepare-shield", async (req, res): Promise<void> => {
  prunePending();
  const parsed = PrepareShieldBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, codeHash, amount, chainDepth } = parsed.data;
  const amountLamports = BigInt(Math.round(amount * LAMPORTS_PER_SOL));

  if (SIM_MODE) {
    const freshWallet = Keypair.generate();
    const stokenAtaKp = Keypair.generate();
    const mintKp = Keypair.generate();
    const id = pendingId();
    await db.insert(pendingShieldsTable).values({
      pendingId: id,
      wallet,
      freshWalletKeypair: encodeKeypair(freshWallet),
      stokenAtaKeypair: encodeKeypair(stokenAtaKp),
      mintStoken: mintKp.publicKey.toBase58(),
      poolPda: "sim-pool",
      codeHash,
      chainDepth,
      amountLamports: "0",
      rentExtra: "0",
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });
    req.log.info({ wallet, chainDepth, pendingId: id }, "prepare-shield: sim mode");
    res.json({
      sim: true,
      pendingId: id,
      stokenAccount: stokenAtaKp.publicKey.toBase58(),
      mintStoken: mintKp.publicKey.toBase58(),
      chainDepth,
    });
    return;
  }

  try {
    const conn = getConnection();

    const poolState = await fetchPoolState(conn);
    if (!poolState) {
      res.status(503).json({ error: "Pool not initialized. Contact support." });
      return;
    }

    // Calculate how much extra SOL freshWallet needs for account rents:
    //   stoken_ata: 174 bytes (ImmutableOwner + NonTransferableAccount; PermanentDelegate is on MINT not account)
    //   user_state PDA: ~90 bytes (Anchor account)
    //   freshWallet itself: must end up rent-exempt after paying everything, so include
    //   the 0-byte account minimum (ephemeralRent) to avoid sub-minimum dust failure.
    const stokenAtaRent = await conn.getMinimumBalanceForRentExemption(174);
    const userStateRent = await conn.getMinimumBalanceForRentExemption(90);
    const ephemeralRent  = await conn.getMinimumBalanceForRentExemption(0);
    const rentExtra = BigInt(stokenAtaRent + userStateRent + ephemeralRent + 20_000); // +20k fee buffer

    const freshWallet = Keypair.generate();
    const stokenAtaKp = Keypair.generate();

    const id = pendingId();
    await db.insert(pendingShieldsTable).values({
      pendingId: id,
      wallet,
      freshWalletKeypair: encodeKeypair(freshWallet),
      stokenAtaKeypair: encodeKeypair(stokenAtaKp),
      mintStoken: poolState.mintStoken.toBase58(),
      poolPda: poolState.publicKey.toBase58(),
      codeHash,
      chainDepth,
      amountLamports: amountLamports.toString(),
      rentExtra: rentExtra.toString(),
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });

    // Build a plain SOL transfer that Phantom will show as "Send X.XX SOL".
    // User transfers ONLY their shield amount. Relayer funds rent separately
    // inside the shield tx via a SystemProgram.transfer relayer -> freshWallet.
    const userPk = new PublicKey(wallet);
    const transferIx = SystemProgram.transfer({
      fromPubkey: userPk,
      toPubkey: freshWallet.publicKey,
      lamports: amountLamports,
    });

    const tx = await buildVersionedTx(conn, userPk, [transferIx]);
    // User is fee payer (Phantom requirement: fee payer = user for Phantom to show correct info)
    // No pre-signing needed; just serialize and send to client

    req.log.info(
      {
        wallet,
        chainDepth,
        freshWallet: freshWallet.publicKey.toBase58(),
        stokenAta: stokenAtaKp.publicKey.toBase58(),
        amountLamports: amountLamports.toString(),
        rentExtra: rentExtra.toString(),
        pendingId: id,
      },
      "prepare-shield: SOL transfer tx built (user pays amount only, relayer funds rent)"
    );

    res.json({
      pendingId: id,
      txBase64: Buffer.from(tx.serialize()).toString("base64"),
      mintStoken: poolState.mintStoken.toBase58(),
      stokenAccount: stokenAtaKp.publicKey.toBase58(),
      freshWalletPubkey: freshWallet.publicKey.toBase58(),
      poolPda: poolState.publicKey.toBase58(),
      chainDepth,
      rentExtraLamports: rentExtra.toString(),
    });
  } catch (err) {
    req.log.error({ err }, "prepare-shield error");
    res.status(500).json({ error: "Failed to build shield transaction" });
  }
});

// ─── POST /vault/confirm-shield ───────────────────────────────────────────────
// Called after user has signed and broadcast the SOL transfer.
// Server verifies SOL arrived at freshWallet, then calls the shield instruction
// using freshWallet + stokenAtaKp as signers (relayer is fee payer).
// Saves vault record to DB including ownerKeypair (never exposed to client).
// Returns { txSig, mintStoken, stokenAccount, codeHash, chainDepth }.

router.post("/vault/confirm-shield", async (req, res): Promise<void> => {
  prunePending();
  const parsed = ConfirmShieldBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { pendingId: id, wallet } = parsed.data;

  const pending = await getPendingShield(id);
  if (!pending) {
    res.status(400).json({ error: "Shield session expired or not found. Start again." });
    return;
  }

  const { freshWallet, stokenAtaKp, mintStoken, codeHash, chainDepth, amountLamports, rentExtra } = pending;

  if (SIM_MODE) {
    await deletePendingShield(id);
    const txSig = simSig();
    const userWallet = wallet;

    // Save vault record in SIM mode
    try {
      const [existing] = await db.select().from(vaultsTable).where(eq(vaultsTable.wallet, userWallet));
      if (existing) {
        await db.update(vaultsTable)
          .set({
            chainDepth,
            lastOts: codeHash,
            mint: mintStoken,
            stokenAccount: stokenAtaKp.publicKey.toBase58(),
            ownerKeypair: encodeKeypair(freshWallet),
          })
          .where(eq(vaultsTable.wallet, userWallet));
      } else {
        await db.insert(vaultsTable).values({
          wallet: userWallet,
          chainDepth,
          lastOts: codeHash,
          mint: mintStoken,
          stokenAccount: stokenAtaKp.publicKey.toBase58(),
          ownerKeypair: encodeKeypair(freshWallet),
        });
      }
    } catch (dbErr) {
      req.log.warn({ dbErr }, "confirm-shield sim: DB save failed (non-fatal)");
    }

    req.log.info({ wallet: userWallet, chainDepth }, "confirm-shield: sim mode completed");
    res.json({ txSig, mintStoken, stokenAccount: stokenAtaKp.publicKey.toBase58(), codeHash, chainDepth, sim: true });
    return;
  }

  if (!relayerKeypair) {
    res.status(503).json({ error: "Relayer not configured." });
    return;
  }

  try {
    const conn = getConnection();

    // Verify user's SOL transfer arrived at freshWallet.
    // User only sends their shield amount; relayer will add rentExtra in the shield tx itself.
    const balance = await conn.getBalance(freshWallet.publicKey, "confirmed");
    const minExpected = Number(amountLamports) - 5_000; // small tolerance for timing/rounding
    if (balance < minExpected) {
      res.status(400).json({
        error: `Waiting for SOL transfer. Expected ${(Number(amountLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL at freshWallet, got ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL. Wait a moment and try confirming again.`,
      });
      return;
    }

    const userWalletPk = new PublicKey(wallet);
    const mintPk = new PublicKey(mintStoken);
    const otsTip = Buffer.from(codeHash, "hex");

    // Relayer funds freshWallet with rent for all accounts it must create.
    // User only transferred their shield amount, so relayer covers the rest here.
    const rentFundIx = SystemProgram.transfer({
      fromPubkey: relayerKeypair.publicKey,
      toPubkey: freshWallet.publicKey,
      lamports: rentExtra,
    });

    const realShieldIx = buildShieldIx(
      freshWallet.publicKey,
      userWalletPk,     // display_owner = user's real wallet
      mintPk,
      stokenAtaKp.publicKey,
      { otsTip, chainDepth, amount: amountLamports },
    );

    // Mix layer: build N decoy_shield instructions alongside the real shield.
    // Keypairs are taken from the pre-generated pool (mix_wallets status="ready").
    // On-chain state (sSOL) is created here, not by the background worker.
    // Position of the real shield ix is randomized among the decoys.
    const decoyCount = SIM_MODE ? 0 : MIX_SHIELD_DECOYS;
    const decoyKps: Keypair[] = [];
    const decoyFreshWalletKps: Keypair[] = [];
    const decoyIxs = [];
    const decoyPoolIds: number[] = [];   // DB row IDs to mark "available" after confirm
    const decoyAtaStrings: string[] = [];

    if (decoyCount > 0) {
      try {
        // Pull pre-generated keypairs from pool; fall back to fresh if pool is empty
        const poolRows = await pickAndReserveReadyKeypairs(decoyCount);

        for (let i = 0; i < decoyCount; i++) {
          let decoyKp: Keypair;
          let decoyFreshWalletKp: Keypair;

          if (poolRows[i]?.secretKey) {
            // Use pre-generated keypairs from pool
            decoyKp = Keypair.fromSecretKey(Buffer.from(poolRows[i].secretKey!, "base64"));
            decoyFreshWalletKp = poolRows[i].displayOwnerSecret
              ? Keypair.fromSecretKey(Buffer.from(poolRows[i].displayOwnerSecret!, "base64"))
              : Keypair.generate(); // backward compat for old rows without displayOwnerSecret
            decoyPoolIds.push(poolRows[i].id);
          } else {
            // Fallback: generate fresh keypairs on the fly
            decoyKp = Keypair.generate();
            decoyFreshWalletKp = Keypair.generate();
          }

          const randOtsTip = randomBytes(32);
          const randDepth = 8 + Math.floor(Math.random() * 57);
          const decoyIx = buildDecoyShieldIx(
            relayerKeypair.publicKey,
            decoyFreshWalletKp.publicKey,
            mintPk,
            decoyKp.publicKey,
            { otsTip: randOtsTip, chainDepth: randDepth, amount: amountLamports },
          );
          decoyKps.push(decoyKp);
          decoyFreshWalletKps.push(decoyFreshWalletKp);
          decoyIxs.push(decoyIx);
          decoyAtaStrings.push(decoyKp.publicKey.toBase58());
        }
      } catch {
        // Mix layer failure is non-fatal: proceed with real shield only
        decoyKps.length = 0;
        decoyFreshWalletKps.length = 0;
        decoyIxs.length = 0;
        decoyPoolIds.length = 0;
        decoyAtaStrings.length = 0;
      }
    }

    // Real shield TX: rentFundIx + realShieldIx only.
    // Each decoy_shield needs 2 extra signers (stokenAtaKp + freshWalletKp) so fitting
    // 20 decoys in one TX would blow through the 1232-byte limit. Instead, decoys are
    // batched 2-per-TX and broadcast simultaneously so they all land in the same block.
    // Observers see N+1 shields in one slot and cannot identify which is real.
    const txReal = await buildVersionedTx(conn, relayerKeypair.publicKey, [rentFundIx, realShieldIx]);
    txReal.sign([relayerKeypair, freshWallet, stokenAtaKp]);

    // Build decoy_shield TXs in batches of 2 (each stays well under 1232 bytes)
    const decoyShieldTxs: VersionedTransaction[] = [];
    for (let i = 0; i < decoyIxs.length; i += 2) {
      const batch = decoyIxs.slice(i, i + 2);
      const batchKps = decoyKps.slice(i, i + 2);
      const batchFreshKps = decoyFreshWalletKps.slice(i, i + 2);
      const batchTx = await buildVersionedTx(conn, relayerKeypair.publicKey, batch);
      batchTx.sign([relayerKeypair, ...batchKps, ...batchFreshKps]);
      decoyShieldTxs.push(batchTx);
    }

    let txSig: string;
    try {
      const broadcasts: Promise<string>[] = [
        conn.sendRawTransaction(txReal.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" }),
        ...decoyShieldTxs.map((dtx) =>
          conn.sendRawTransaction(dtx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" })
        ),
      ];
      const results = await Promise.allSettled(broadcasts);
      const realResult = results[0];
      if (realResult.status === "rejected") throw realResult.reason as Error;
      txSig = realResult.value;
      const decoysFailed = results.slice(1).filter((r) => r.status === "rejected").length;
      req.log.info(
        { txSig, decoyCount: decoyIxs.length, decoyBatches: decoyShieldTxs.length, decoysFailed },
        "confirm-shield: all TXs broadcast simultaneously"
      );
    } catch (txErr) {
      const msg = txErr instanceof Error ? txErr.message : String(txErr);
      req.log.warn({ txErr }, "confirm-shield: on-chain tx failed, auto-refunding");
      void autoRefundSol(conn, freshWallet, wallet, "confirm-shield-tx-failed");
      // Release any pool keypairs back to "ready" so they can be reused
      if (decoyPoolIds.length > 0) {
        void db.update(mixWalletsTable)
          .set({ status: "ready" })
          .where(sql`id = ANY(ARRAY[${sql.join(decoyPoolIds.map(id => sql`${id}`), sql`, `)}]::int[])`)
          .catch(() => {});
      }
      res.status(400).json({ error: `Shield transaction failed: ${msg}. Your SOL is being returned to your wallet automatically.` });
      return;
    }

    // Store txSig in pending record so shield-status can look it up
    await db.update(pendingShieldsTable)
      .set({ txSig })
      .where(eq(pendingShieldsTable.pendingId, id));

    req.log.info({ wallet, txSig, freshWallet: freshWallet.publicKey.toBase58() }, "confirm-shield: tx broadcast, returning early");

    // Return txSig immediately so the frontend can poll for real-time slot data
    res.json({
      txSig,
      status: "pending",
      mintStoken,
      stokenAccount: stokenAtaKp.publicKey.toBase58(),
      codeHash,
      chainDepth,
    });

    // Background: poll confirmation then persist vault record
    void (async () => {
      try {
        const bgDeadline = Date.now() + 90_000;
        while (Date.now() < bgDeadline) {
          const statuses = await conn.getSignatureStatuses([txSig], { searchTransactionHistory: true });
          const s = statuses.value[0];
          if (s?.err) {
            req.log.warn({ txSig, err: s.err }, "confirm-shield bg: tx failed on-chain");
            return; // pending record stays for debugging
          }
          if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") break;
          await new Promise((r) => setTimeout(r, 1500));
        }

        await deletePendingShield(id);

        const [existing] = await db.select().from(vaultsTable).where(eq(vaultsTable.wallet, wallet));
        if (existing) {
          await db.update(vaultsTable)
            .set({
              chainDepth,
              lastOts: codeHash,
              mint: mintStoken,
              stokenAccount: stokenAtaKp.publicKey.toBase58(),
              ownerKeypair: encodeKeypair(freshWallet),
            })
            .where(eq(vaultsTable.wallet, wallet));
        } else {
          await db.insert(vaultsTable).values({
            wallet,
            chainDepth,
            lastOts: codeHash,
            mint: mintStoken,
            stokenAccount: stokenAtaKp.publicKey.toBase58(),
            ownerKeypair: encodeKeypair(freshWallet),
          });
        }

        // Mark pool-sourced decoy keypairs as "available" (they now have sSOL).
        // For freshly-generated fallback keypairs (not from pool), insert new rows.
        // Only mark accounts that actually exist on-chain -- decoy_shield TXs are
        // broadcast simultaneously and not individually confirmed, so some may have
        // been dropped. A non-existent decoy account causes InvalidAccountData in
        // burn_and_queue when the next unshield or ZK send runs.
        if (decoyAtaStrings.length > 0) {
          const decoyOnchain = await conn.getMultipleAccountsInfo(
            decoyAtaStrings.map(a => new PublicKey(a))
          ).catch(() => null);

          const confirmedPoolIds = decoyPoolIds.filter((_, i) => !decoyOnchain || decoyOnchain[i] !== null);
          if (confirmedPoolIds.length > 0) {
            await db.update(mixWalletsTable)
              .set({ status: "available", secretKey: null, amountLamports: amountLamports.toString(), lastUsedAt: new Date() })
              .where(sql`id = ANY(ARRAY[${sql.join(confirmedPoolIds.map(id => sql`${id}`), sql`, `)}]::int[])`)
              .catch(() => {});
          }

          for (let di = 0; di < decoyAtaStrings.length; di++) {
            if (di < decoyPoolIds.length) continue;
            if (decoyOnchain && decoyOnchain[di] === null) continue;
            const decoyKp = decoyKps[di];
            await db.insert(mixWalletsTable).values({
              stokenAta: decoyAtaStrings[di],
              displayOwner: decoyKp?.publicKey.toBase58() ?? "unknown",
              amountLamports: amountLamports.toString(),
              status: "available",
            }).onConflictDoNothing().catch(() => {});
          }

          const confirmedCount = decoyOnchain ? decoyOnchain.filter(i => i !== null).length : decoyAtaStrings.length;
          const skippedCount = decoyAtaStrings.length - confirmedCount;
          if (skippedCount > 0) {
            req.log.warn({ skippedCount, total: decoyAtaStrings.length }, "confirm-shield bg: some decoy TXs not confirmed on-chain, skipping those accounts");
          }
          req.log.info({ count: confirmedCount, fromPool: confirmedPoolIds.length }, "confirm-shield bg: decoy accounts marked available in mix pool");
        }

        req.log.info({ wallet, txSig, chainDepth }, "confirm-shield bg: vault saved");
      } catch (bgErr) {
        req.log.error({ bgErr, wallet, txSig }, "confirm-shield bg: vault save failed");
      }
    })();
  } catch (err) {
    req.log.error({ err }, "confirm-shield error");
    res.status(500).json({ error: "Shield confirmation failed" });
  }
});

// ─── GET /vault/shield-status ─────────────────────────────────────────────────
// Polled by the frontend after confirm-shield returns txSig.
// Returns real-time RPC confirmation status + slot for the terminal log UI.

router.get("/vault/shield-status", async (req, res): Promise<void> => {
  const sig = req.query.sig as string | undefined;
  const wallet = req.query.wallet as string | undefined;

  if (!sig) {
    res.status(400).json({ error: "sig required" });
    return;
  }

  try {
    const conn = getConnection();
    const statuses = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = statuses.value[0];

    let vaultSaved = false;
    if (wallet) {
      const [v] = await db
        .select({ wallet: vaultsTable.wallet })
        .from(vaultsTable)
        .where(eq(vaultsTable.wallet, wallet));
      vaultSaved = !!v;
    }

    if (!s) {
      res.json({ confirmationStatus: "unknown", slot: null, vaultSaved });
      return;
    }
    if (s.err) {
      res.json({ confirmationStatus: "failed", err: s.err, slot: s.slot, vaultSaved });
      return;
    }
    res.json({
      confirmationStatus: s.confirmationStatus ?? "unknown",
      slot: s.slot ?? null,
      vaultSaved,
    });
  } catch (err) {
    req.log.error({ err }, "shield-status error");
    res.status(500).json({ error: "Status check failed" });
  }
});

// ─── POST /vault/prepare-deposit ─────────────────────────────────────────────
// TWO-ACTOR DESIGN:
// Generates freshDepositWallet server-side. Builds a plain
// SystemProgram.transfer(userWallet -> freshDepositWallet, amount) for user to sign.
// No program instruction in this tx = no Phantom warning.

router.post("/vault/prepare-deposit", async (req, res): Promise<void> => {
  prunePending();
  const parsed = PrepareDepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, amount } = parsed.data;
  const amountLamports = BigInt(Math.round(amount * LAMPORTS_PER_SOL));

  if (SIM_MODE) {
    const freshDepositWallet = Keypair.generate();
    const id = pendingId();
    await db.insert(pendingDepositsTable).values({
      pendingId: id,
      wallet,
      freshDepositWalletKeypair: encodeKeypair(freshDepositWallet),
      amountLamports: amountLamports.toString(),
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });
    req.log.info({ wallet, amount }, "prepare-deposit: sim mode");
    res.json({ sim: true, pendingId: id });
    return;
  }

  if (!relayerKeypair) {
    res.status(503).json({ error: "Relayer not configured" });
    return;
  }

  const [vault] = await db
    .select()
    .from(vaultsTable)
    .where(eq(vaultsTable.wallet, wallet))
    .limit(1);

  if (!vault || !vault.mint || !vault.stokenAccount) {
    res.status(404).json({ error: "Vault not found or missing token accounts. Shield first." });
    return;
  }

  if (!vault.ownerKeypair) {
    res.status(400).json({ error: "This vault was created before the two-actor upgrade and cannot accept server-side deposits. Please create a new vault." });
    return;
  }

  try {
    const conn = getConnection();
    const userPk = new PublicKey(wallet);

    // Verify user_state actually exists on-chain before building the deposit tx.
    // Stale sim-mode vaults exist in DB but have no on-chain state: catch them here
    // before the user broadcasts a SOL transfer that would be unrecoverable.
    const stokenAtaCheck = new PublicKey(vault.stokenAccount);
    const onchainState = await fetchUserState(conn, stokenAtaCheck);
    if (!onchainState) {
      // Stale vault: purge from DB so the frontend shows the shield form.
      await db.delete(vaultsTable).where(eq(vaultsTable.wallet, wallet));
      req.log.warn({ wallet, stokenAccount: vault.stokenAccount }, "prepare-deposit: user_state not found on-chain, cleared stale vault");
      res.status(404).json({ error: "No on-chain vault found. Your previous vault was not confirmed. Shield first to create a new one." });
      return;
    }

    const freshDepositWallet = Keypair.generate();

    const id = pendingId();
    await db.insert(pendingDepositsTable).values({
      pendingId: id,
      wallet,
      freshDepositWalletKeypair: encodeKeypair(freshDepositWallet),
      amountLamports: amountLamports.toString(),
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });

    const transferIx = SystemProgram.transfer({
      fromPubkey: userPk,
      toPubkey: freshDepositWallet.publicKey,
      lamports: amountLamports,
    });

    const tx = await buildVersionedTx(conn, userPk, [transferIx]);

    req.log.info({ wallet, amount, freshDepositWallet: freshDepositWallet.publicKey.toBase58(), pendingId: id }, "prepare-deposit: SOL transfer tx built");

    res.json({
      pendingId: id,
      txBase64: Buffer.from(tx.serialize()).toString("base64"),
      freshDepositWalletPubkey: freshDepositWallet.publicKey.toBase58(),
    });
  } catch (err) {
    req.log.error({ err }, "prepare-deposit error");
    res.status(500).json({ error: "Failed to build deposit transaction" });
  }
});

// ─── POST /vault/confirm-deposit ─────────────────────────────────────────────
// Called after user has broadcast the SOL transfer.
// Server verifies SOL arrived, then calls deposit instruction using stored
// ownerKeypair (freshWallet from original shield). Relayer pays tx fees.

router.post("/vault/confirm-deposit", async (req, res): Promise<void> => {
  prunePending();
  const parsed = ConfirmDepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { pendingId: id, wallet } = parsed.data;

  const [pendingRow] = await db
    .select()
    .from(pendingDepositsTable)
    .where(eq(pendingDepositsTable.pendingId, id));

  if (!pendingRow) {
    // The deposit-watcher may have already processed this session and deleted the row.
    // Check the in-memory completion store before reporting an error.
    const watcherTxSig = getWatcherCompletion(id);
    if (watcherTxSig) {
      req.log.info({ wallet, pendingId: id, txSig: watcherTxSig }, "confirm-deposit: deposit already completed by watcher, returning success");
      res.json({ txSig: watcherTxSig });
      return;
    }
    res.status(400).json({ error: "Deposit session expired or not found. Start again." });
    return;
  }
  if (new Date(pendingRow.expiresAt).getTime() < Date.now()) {
    // Expired: auto-refund then delete
    const fromKp = decodeKeypair(pendingRow.freshDepositWalletKeypair);
    void autoRefundSol(getConnection(), fromKp, pendingRow.wallet, "confirm-deposit-expired");
    await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.pendingId, id));
    res.status(400).json({ error: "Deposit session expired. Your SOL is being returned to your wallet automatically." });
    return;
  }

  const freshDepositWallet = decodeKeypair(pendingRow.freshDepositWalletKeypair);
  const amountLamports = BigInt(pendingRow.amountLamports);

  if (SIM_MODE) {
    await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.pendingId, id));
    const txSig = simSig();
    req.log.info({ wallet }, "confirm-deposit: sim mode completed");
    res.json({ txSig, sim: true });
    return;
  }

  if (!relayerKeypair) {
    res.status(503).json({ error: "Relayer not configured." });
    return;
  }

  const [vault] = await db.select().from(vaultsTable).where(eq(vaultsTable.wallet, wallet)).limit(1);
  if (!vault || !vault.mint || !vault.stokenAccount || !vault.ownerKeypair) {
    void autoRefundSol(getConnection(), freshDepositWallet, wallet, "confirm-deposit-no-vault");
    await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.pendingId, id));
    res.status(404).json({ error: "Vault not found or missing keypair. Your SOL is being returned to your wallet automatically." });
    return;
  }

  try {
    const conn = getConnection();

    // Verify SOL arrived at freshDepositWallet
    const balance = await conn.getBalance(freshDepositWallet.publicKey, "confirmed");
    if (balance < Number(amountLamports) - 10_000) {
      res.status(400).json({
        error: `Waiting for SOL transfer. Expected ${(Number(amountLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL, got ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL. Wait a moment and try again.`,
      });
      return;
    }

    const userWalletPk = new PublicKey(wallet);
    const mintPk = new PublicKey(vault.mint);
    const stokenAtaPk = new PublicKey(vault.stokenAccount);

    const ix = buildDepositIx(
      freshDepositWallet.publicKey,
      userWalletPk,         // display_owner = user's real wallet
      mintPk,
      stokenAtaPk,
      { amount: BigInt(balance) },
    );

    // Fee payer = relayer. freshDepositWallet pays deposit SOL inside the instruction.
    const tx = await buildVersionedTx(conn, relayerKeypair.publicKey, [ix]);
    tx.sign([relayerKeypair, freshDepositWallet]);

    let txSig: string;
    try {
      txSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
    } catch (txErr) {
      const msg = txErr instanceof Error ? txErr.message : String(txErr);
      req.log.warn({ txErr }, "confirm-deposit: on-chain tx failed, auto-refunding");
      // Auto-refund SOL back to user before returning error
      void autoRefundSol(conn, freshDepositWallet, wallet, "confirm-deposit-tx-failed");
      await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.pendingId, id));
      res.status(400).json({ error: `Deposit transaction failed: ${msg}. Your SOL is being returned to your wallet automatically.` });
      return;
    }

    await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.pendingId, id));
    req.log.info({ wallet, txSig }, "confirm-deposit: deposit broadcast");

    res.json({ txSig });
  } catch (err) {
    req.log.error({ err }, "confirm-deposit error");
    res.status(500).json({ error: "Deposit confirmation failed" });
  }
});

// ─── Background deposit watcher ───────────────────────────────────────────────
// Runs every 15 seconds. For every pending deposit in DB, checks if SOL has
// arrived at the fresh wallet. If yes, executes the deposit instruction
// automatically without waiting for the browser to call confirm-deposit.
// This means even if the user closes the tab after signing the SOL transfer,
// the deposit still completes on-chain.

async function executeDeposit(
  conn: ReturnType<typeof getConnection>,
  pendingId: string,
  freshDepositWallet: Keypair,
  wallet: string,
  balance: number,
): Promise<void> {
  if (!relayerKeypair) return;

  const [vault] = await db
    .select()
    .from(vaultsTable)
    .where(eq(vaultsTable.wallet, wallet))
    .limit(1);

  if (!vault || !vault.mint || !vault.stokenAccount || !vault.ownerKeypair) {
    logger.warn({ wallet, pendingId }, "deposit-watcher: vault missing, refunding");
    await autoRefundSol(conn, freshDepositWallet, wallet, "watcher-no-vault");
    await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.pendingId, pendingId));
    return;
  }

  const userWalletPk = new PublicKey(wallet);
  const mintPk = new PublicKey(vault.mint);
  const stokenAtaPk = new PublicKey(vault.stokenAccount);

  const ix = buildDepositIx(
    freshDepositWallet.publicKey,
    userWalletPk,
    mintPk,
    stokenAtaPk,
    { amount: BigInt(balance) },
  );

  const tx = await buildVersionedTx(conn, relayerKeypair.publicKey, [ix]);
  tx.sign([relayerKeypair, freshDepositWallet]);

  let txSig: string;
  try {
    txSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  } catch (txErr) {
    logger.warn({ txErr, wallet, pendingId }, "deposit-watcher: on-chain tx failed, refunding");
    await autoRefundSol(conn, freshDepositWallet, wallet, "watcher-tx-failed");
    await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.pendingId, pendingId));
    return;
  }

  await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.pendingId, pendingId));
  storeWatcherCompletion(pendingId, txSig);
  logger.info({ wallet, txSig, pendingId, lamports: balance }, "deposit-watcher: deposit completed automatically");

  // Record in transactions + vault balances
  const amountSol = balance / LAMPORTS_PER_SOL;
  try {
    const solPrice = await getSolPriceUsd().catch(() => null);
    await db.insert(transactionsTable).values({
      wallet,
      signature: txSig,
      type: "shield",
      token: "sSOL",
      amount: amountSol.toFixed(9),
      usdValue: solPrice ? (amountSol * solPrice).toFixed(2) : undefined,
      status: "confirmed",
    });
    await upsertVaultBalance(wallet, "sSOL", amountSol, vault.mint ?? undefined);
  } catch (dbErr) {
    logger.warn({ dbErr, wallet, txSig }, "deposit-watcher: DB record failed (non-fatal, deposit succeeded on-chain)");
  }
}

export function startDepositWatcher(): void {
  const INTERVAL_MS = 15_000;

  const tick = async () => {
    if (SIM_MODE || !relayerKeypair) return;
    try {
      const now = new Date();
      const rows = await db.select().from(pendingDepositsTable);
      if (rows.length === 0) return;

      const conn = getConnection();

      for (const row of rows) {
        const expired = new Date(row.expiresAt).getTime() < Date.now();
        const freshKp = decodeKeypair(row.freshDepositWalletKeypair);

        if (expired) {
          logger.info({ wallet: row.wallet, pendingId: row.pendingId }, "deposit-watcher: session expired, refunding");
          await autoRefundSol(conn, freshKp, row.wallet, "watcher-expired");
          await db.delete(pendingDepositsTable).where(eq(pendingDepositsTable.pendingId, row.pendingId));
          continue;
        }

        const balance = await conn.getBalance(freshKp.publicKey, "confirmed");
        const minExpected = Number(BigInt(row.amountLamports)) - 10_000;
        if (balance < minExpected) continue; // SOL not arrived yet

        logger.info({ wallet: row.wallet, pendingId: row.pendingId, balance }, "deposit-watcher: SOL detected, executing deposit");
        await executeDeposit(conn, row.pendingId, freshKp, row.wallet, balance);
      }
    } catch (err) {
      logger.warn({ err }, "deposit-watcher: tick error (non-fatal)");
    }
  };

  setInterval(() => { void tick(); }, INTERVAL_MS);
  logger.info({ intervalMs: INTERVAL_MS }, "deposit-watcher: started");
}

// ─── POST /vault/create ───────────────────────────────────────────────────────
// Records a vault in the DB after confirm-shield (or legacy direct shield).
// Does NOT touch ownerKeypair -- that is saved by confirm-shield.

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
      const updates: Record<string, unknown> = { chainDepth, lastOts: codeHash };
      if (mint) updates.mint = mint;
      if (stokenAccount) updates.stokenAccount = stokenAccount;
      // ownerKeypair is intentionally NOT in updates -- preserved from confirm-shield
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
      req.log.info({ wallet, chainDepth, mint: mint ?? "none", stokenAccount: stokenAccount ?? "none", txSig: txSig ?? "none" }, "Vault shielded on-chain");
    }

    if (token && amount) {
      const sToken = "s" + token;
      const sig = txSig ?? offchainSig();
      const solPriceVc = await getSolPriceUsd().catch(() => null);
      await db.insert(transactionsTable).values({
        wallet,
        signature: sig,
        type: "shield",
        token: sToken,
        amount: amount.toFixed(9),
        usdValue: solPriceVc ? (amount * solPriceVc).toFixed(2) : undefined,
        status: txSig ? "confirmed" : "pending",
      });
      await upsertVaultBalance(wallet, sToken, amount, mint);
      req.log.info({ wallet, token: sToken, amount, mint: mint ?? "pending" }, "Shield deposit recorded");
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

// ─── POST /vault/deposit ──────────────────────────────────────────────────────

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
    const solPriceDeposit = await getSolPriceUsd().catch(() => null);

    // Use onConflictDoNothing so the deposit-watcher inserting first never throws.
    // If the row already exists (watcher beat us), inserted will be empty.
    const inserted = await db
      .insert(transactionsTable)
      .values({
        wallet,
        signature: sig,
        type: "shield",
        token: sToken,
        amount: amount.toFixed(9),
        usdValue: solPriceDeposit ? (amount * solPriceDeposit).toFixed(2) : undefined,
        status: txSig ? "confirmed" : "pending",
      })
      .onConflictDoNothing()
      .returning({ id: transactionsTable.id });

    if (inserted.length === 0) {
      // Watcher already recorded this tx -- balance is already updated too.
      req.log.info({ wallet, txSig }, "vault/deposit: already recorded by watcher, skipping");
      res.json({ success: true });
      return;
    }

    await upsertVaultBalance(wallet, sToken, amount);

    req.log.info({ wallet, token: sToken, amount, txSig: txSig ?? "none" }, "Vault deposit recorded");

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Vault deposit error");
    res.status(500).json({ error: "Failed to record deposit" });
  }
});

// ─── POST /vault/unshield ─────────────────────────────────────────────────────
// OTS-verified private transfer: burns sSOL, sends SOL from pool to recipient.
// Owner wallet does NOT appear in the transaction.
// Relayer signs and broadcasts fully server-side.

router.post("/vault/unshield", async (req, res): Promise<void> => {
  const parsed = PrivateSendBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, amount, destination, preimage, token, stokenAccount: stokenAccountParam } = parsed.data;

  try {
    const [vault] = await db
      .select()
      .from(vaultsTable)
      .where(
        stokenAccountParam
          ? and(eq(vaultsTable.wallet, wallet), eq(vaultsTable.stokenAccount, stokenAccountParam))
          : eq(vaultsTable.wallet, wallet),
      );

    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    if (SIM_MODE) {
      const computed = sha256Hex(preimage);
      if (computed !== vault.lastOts) {
        res.status(400).json({ error: "Vault code incorrect or wrong step." });
        return;
      }
      const newDepth = Math.max(0, (vault.chainDepth ?? 1) - 1);
      const txSig = simSig();
      const sToken = token ? "s" + token : null;
      try {
        await db.update(vaultsTable).set({ lastOts: preimage, chainDepth: newDepth }).where(eq(vaultsTable.wallet, wallet));
        await db.insert(transactionsTable).values({ wallet, signature: txSig, type: "unshield", token: sToken, amount: amount.toFixed(9), status: "confirmed" });
        if (sToken) await upsertVaultBalance(wallet, sToken, -amount);
      } catch (dbErr) {
        req.log.warn({ dbErr }, "unshield sim: DB update failed");
      }
      req.log.info({ wallet, amount, newDepth }, "unshield: sim mode completed");
      res.json({ success: true, newChainDepth: newDepth, txSig, sim: true });
      return;
    }

    if (!vault.stokenAccount || !vault.mint) {
      res.status(400).json({ error: "sToken account not on record. Re-shield to create a new vault." });
      return;
    }

    if (!relayerKeypair) {
      res.status(503).json({ error: "Relayer not configured." });
      return;
    }

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

    const preimageBytes = Buffer.from(preimage, "hex");
    const computed = sha256Hex(preimage);
    const onchainTip = Buffer.from(onchainState.currentOtsHash).toString("hex");

    if (computed !== onchainTip) {
      await db
        .update(vaultsTable)
        .set({ lastOts: onchainTip, chainDepth: onchainState.chainDepth })
        .where(eq(vaultsTable.wallet, wallet));
      req.log.warn({ wallet, computed, onchainTip, dbDepth: vault.chainDepth, onchainDepth: onchainState.chainDepth }, "unshield: OTS mismatch vs on-chain, DB re-synced");
      res.status(400).json({ error: "Vault code incorrect or wrong step. Vault state re-synced, try again." });
      return;
    }

    const destPk = new PublicKey(destination);
    const mintPk = new PublicKey(vault.mint);
    const amountLamports = BigInt(Math.round(amount * 1e9));
    const GAS_LAMPORTS = BigInt(1_000_000);

    const freshWallet = Keypair.generate();
    req.log.info({ wallet, freshWallet: freshWallet.publicKey.toBase58() }, "unshield 2TX: fresh wallet generated");

    // Mix layer: pick decoy ATAs and pass them as remaining_accounts directly
    // into burn_and_queue. All N+1 burns (real + decoys) execute inside the SAME
    // instruction, appearing as one "Interact" block in the block explorer.
    // TX layout: fundIx + burnIx (2 instructions). ~1186 raw bytes with 20 decoys.
    const decoyRows = await pickAndReserveDecoys(MIX_UNSHIELD_DECOYS);
    let decoyIds = decoyRows.map((r) => r.id);
    let decoyAtaPks = decoyRows.map((r) => new PublicKey(r.stokenAta));

    if (decoyRows.length === 0) {
      req.log.warn({ wallet }, "unshield: no decoy accounts available in mix pool, proceeding with reduced anonymity set");
    }

    // Validate decoy accounts exist on-chain before including in burn TX.
    // Prevents InvalidAccountData if a decoy_shield TX was dropped and the
    // account never actually landed on Solana.
    if (decoyAtaPks.length > 0) {
      const infos = await conn.getMultipleAccountsInfo(decoyAtaPks).catch(() => null);
      if (infos) {
        const invalidIds = decoyIds.filter((_, i) => infos[i] === null);
        if (invalidIds.length > 0) {
          req.log.warn({ invalidCount: invalidIds.length, total: decoyAtaPks.length }, "unshield: dropping non-existent decoy accounts, marking depleted");
          await markDecoysDepeleted(invalidIds);
          decoyAtaPks = decoyAtaPks.filter((_, i) => infos[i] !== null);
          decoyIds = decoyIds.filter((_, i) => infos[i] !== null);
        }
      }
    }

    const fundIx = buildFundFreshRelayerIx(relayerKeypair.publicKey, freshWallet.publicKey, GAS_LAMPORTS);
    const burnIx = buildBurnAndQueueIx(
      freshWallet.publicKey,
      mintPk,
      stokenAtaPk,
      { otsPreimage: Buffer.from(preimageBytes), amount: amountLamports },
      decoyAtaPks,
    );

    req.log.info({ wallet, decoyCount: decoyRows.length }, "unshield 1TX: real burn + " + decoyRows.length + " decoy burns in same instruction");
    const tx1Ixs = [fundIx, burnIx];

    let tx1Sig: string;
    try {
      const tx1 = await buildVersionedTx(conn, relayerKeypair.publicKey, tx1Ixs);
      tx1.sign([relayerKeypair, freshWallet]);
      tx1Sig = await conn.sendRawTransaction(tx1.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
    } catch (txErr) {
      const msg = txErr instanceof Error ? txErr.message : String(txErr);
      req.log.warn({ txErr }, "unshield 1TX: burn_and_queue failed");
      await releaseDecoys(decoyIds);
      res.status(400).json({ error: `On-chain burn failed: ${msg}` });
      return;
    }

    req.log.info({ wallet, tx1Sig }, "unshield 1TX: burn broadcast, confirming...");

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const statuses = await conn.getSignatureStatuses([tx1Sig], { searchTransactionHistory: true });
      const s = statuses.value[0];
      if (s?.err) {
        req.log.warn({ tx1Sig, err: s.err }, "unshield 2TX: TX1 failed on-chain");
        res.status(400).json({ error: "Burn transaction failed on-chain" });
        return;
      }
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    req.log.info({ wallet, tx1Sig }, "unshield 2TX: TX1 confirmed");

    // Mark decoy accounts as depleted after successful burn confirmation
    await markDecoysDepeleted(decoyIds);

    // 0.15% relayer fee (15 basis points). Two processQueue instructions in the same TX2:
    // Ix1: pool -> recipient  (amountLamports - fee)
    // Ix2: pool -> relayer    (fee)
    // Total deducted from pool equals the full amountLamports that was burned in TX1.
    const fee = amountLamports * 15n / 10_000n;
    const recipientAmount = amountLamports - fee;

    const processIx = buildProcessQueueIx(relayerKeypair.publicKey, destPk, recipientAmount);
    const feeIx = buildProcessQueueIx(relayerKeypair.publicKey, relayerKeypair.publicKey, fee);

    let tx2Sig: string;
    try {
      const tx2 = await buildVersionedTx(conn, relayerKeypair.publicKey, [processIx, feeIx]);
      tx2.sign([relayerKeypair]);
      tx2Sig = await conn.sendRawTransaction(tx2.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
    } catch (txErr) {
      const msg = txErr instanceof Error ? txErr.message : String(txErr);
      req.log.warn({ txErr, tx1Sig }, "unshield 2TX: TX2 (process_queue) failed");
      res.status(400).json({ error: `SOL release failed: ${msg}` });
      return;
    }

    req.log.info({ wallet, tx1Sig, tx2Sig, destination, amount, fee: fee.toString(), recipientAmount: recipientAmount.toString() }, "unshield 2TX: TX2 broadcast");

    const newDepth = onchainState.chainDepth - 1;
    const sToken = token ? "s" + token : null;
    const txSig = tx2Sig;

    try {
      await db
        .update(vaultsTable)
        .set({ lastOts: preimage, chainDepth: newDepth })
        .where(eq(vaultsTable.wallet, wallet));

      await db.insert(transactionsTable).values({
        wallet,
        signature: txSig,
        type: "unshield",
        token: sToken,
        amount: amount.toFixed(9),
        status: "confirmed",
      });

      if (sToken) await upsertVaultBalance(wallet, sToken, -amount);
    } catch (recordErr) {
      req.log.warn({ recordErr }, "unshield 2TX: DB update failed after successful tx (non-fatal)");
    }

    res.json({
      success: true,
      newChainDepth: newDepth,
      txSig,
      tx1Sig,
    });
  } catch (err) {
    req.log.error({ err }, "Vault unshield error");
    res.status(500).json({ error: "Unshield failed" });
  }
});

// ─── POST /vault/prepare-refresh ─────────────────────────────────────────────
// For new vaults (ownerKeypair in DB): fully server-side, returns { txSig }.
// For legacy vaults (no ownerKeypair): old relay flow, returns { txBase64 }.

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

  const { wallet, newOtsTip, chainDepth, otsPreimage } = parsed.data;

  try {
    const [vault] = await db.select().from(vaultsTable).where(eq(vaultsTable.wallet, wallet));
    if (!vault || !vault.stokenAccount) {
      res.status(404).json({ error: "Vault not found or missing sToken account." });
      return;
    }

    // Authenticate the vault code change: require old OTS preimage that matches the current
    // on-chain tip. This prevents an unauthenticated caller from replacing the OTS chain.
    // Same security model as Base's refreshOts contract check, applied server-side here.
    if (!otsPreimage) {
      res.status(400).json({ error: "Current vault code required to change vault code." });
      return;
    }
    try {
      const verifyConn = getConnection();
      const verifyAtaPk = new PublicKey(vault.stokenAccount);
      const onchainState = await fetchUserState(verifyConn, verifyAtaPk);
      if (onchainState) {
        const computed = sha256Hex(otsPreimage);
        const onchainTip = Buffer.from(onchainState.currentOtsHash).toString("hex");
        if (computed !== onchainTip) {
          res.status(401).json({ error: "Current vault code incorrect." });
          return;
        }
      }
    } catch (verifyErr) {
      req.log.warn({ verifyErr }, "prepare-refresh: on-chain OTS verify failed (RPC error), rejecting to be safe");
      res.status(503).json({ error: "Cannot verify vault code: RPC unavailable. Try again." });
      return;
    }

    const stokenAtaPk = new PublicKey(vault.stokenAccount);
    const newOtsTipBytes = Buffer.from(newOtsTip, "hex");
    const conn = getConnection();

    if (vault.ownerKeypair) {
      // New vault: fully server-side (no user signature needed)
      const storedOwner = decodeKeypair(vault.ownerKeypair);
      const userWalletPk = new PublicKey(wallet);

      const ix = buildRefreshOtsIx(
        storedOwner.publicKey,
        userWalletPk,
        stokenAtaPk,
        { newOtsTip: new Uint8Array(newOtsTipBytes), newChainDepth: chainDepth },
      );

      const tx = await buildVersionedTx(conn, relayerKeypair.publicKey, [ix]);
      tx.sign([relayerKeypair, storedOwner]);

      let txSig: string;
      try {
        txSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
      } catch (txErr) {
        const msg = txErr instanceof Error ? txErr.message : String(txErr);
        res.status(400).json({ error: `Refresh transaction failed: ${msg}` });
        return;
      }

      req.log.info({ wallet, chainDepth, txSig }, "prepare-refresh: server-side tx broadcast");
      res.json({ serverSide: true, txSig });
    } else {
      // Legacy vault: relay flow (user must sign via Phantom)
      const ownerPk = new PublicKey(wallet);

      const ix = buildRefreshOtsIx(
        ownerPk,
        ownerPk,  // display_owner = owner for legacy vaults (both are userWallet)
        stokenAtaPk,
        { newOtsTip: new Uint8Array(newOtsTipBytes), newChainDepth: chainDepth },
      );

      const tx = await buildVersionedTx(conn, relayerKeypair.publicKey, [ix]);
      tx.sign([relayerKeypair]);

      req.log.info({ wallet, chainDepth }, "prepare-refresh: legacy relay tx built");
      res.json({ txBase64: Buffer.from(tx.serialize()).toString("base64") });
    }
  } catch (err) {
    req.log.error({ err }, "prepare-refresh error");
    res.status(500).json({ error: "Failed to build refresh transaction" });
  }
});

// ─── POST /vault/update-chain ─────────────────────────────────────────────────

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

// ─── POST /vault/:wallet/sync ─────────────────────────────────────────────────

router.post("/vault/:wallet/sync", async (req, res): Promise<void> => {
  const wallet = req.params.wallet as string;
  try {
    const [vault] = await db.select().from(vaultsTable).where(eq(vaultsTable.wallet, wallet));
    if (!vault) {
      res.status(404).json({ error: "DB vault record not found. Register via POST /vault/create first." });
      return;
    }
    if (!vault.stokenAccount) {
      res.status(400).json({ error: "Vault missing stoken_account. Re-shield to generate a new one." });
      return;
    }

    const stokenAtaPk = new PublicKey(vault.stokenAccount);
    const conn = getConnection();
    const state = await fetchUserState(conn, stokenAtaPk);

    if (!state) {
      res.status(404).json({ error: "On-chain user_state PDA not found" });
      return;
    }

    const onchainOts = Buffer.from(state.currentOtsHash).toString("hex");
    const onchainDepth = state.chainDepth;

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

// ─── GET /vault/:wallet ───────────────────────────────────────────────────────

router.get("/vault/:wallet", async (req, res): Promise<void> => {
  const wallet = req.params.wallet as string;

  try {
    const [vault] = await db
      .select()
      .from(vaultsTable)
      .where(eq(vaultsTable.wallet, wallet));

    // onchain: populated when Helius returns account data
    // onchainFetchAttempted: true if we tried RPC (so we can distinguish "not found" vs "RPC error")
    let onchain: { userStatePda: string; chainDepth: number; deposited: string } | null = null;
    let onchainFetchAttempted = false;
    let onchainAccountFound = false;

    if (vault?.stokenAccount) {
      onchainFetchAttempted = true;
      try {
        const stokenAtaPk = new PublicKey(vault.stokenAccount);
        const conn = getConnection();
        const [poolPda] = derivePoolPda();
        const [userStatePda] = deriveUserStatePda(stokenAtaPk);
        const state = await fetchUserState(conn, stokenAtaPk);
        onchainAccountFound = state !== null;
        if (state) {
          onchain = {
            userStatePda: userStatePda.toBase58(),
            chainDepth: state.chainDepth,
            deposited: state.deposited.toString(),
          };
        }
        void poolPda;
      } catch {
        // RPC error: do not treat as "account not found"
        onchainFetchAttempted = false;
      }
    }

    if (!vault) {
      res.json({ vault: null, onchain });
      return;
    }

    // Only purge stale vault if Helius RPC succeeded AND explicitly returned no account.
    // If RPC errored or timed out (onchainFetchAttempted=false), keep the DB record intact.
    if (!SIM_MODE && vault.stokenAccount && onchainFetchAttempted && !onchainAccountFound) {
      try {
        await db.delete(vaultsTable).where(eq(vaultsTable.wallet, wallet));
        req.log.warn({ wallet, stokenAccount: vault.stokenAccount }, "GET vault: stale vault purged (on-chain user_state confirmed absent)");
      } catch {
        // Non-fatal: even if delete fails, return null so frontend re-shields
      }
      res.json({ vault: null, onchain: null });
      return;
    }

    // Use on-chain chainDepth as the authoritative value when available; fall back to DB.
    const chainDepthDisplay = onchain?.chainDepth ?? vault.chainDepth;

    res.json({
      vault: {
        wallet: vault.wallet,
        chainDepth: chainDepthDisplay,
        lastOts: vault.lastOts ?? null,
        stokenAccount: vault.stokenAccount ?? null,
        mint: vault.mint ?? null,
        createdAt: vault.createdAt.toISOString(),
        // ownerKeypair intentionally omitted from response
      },
      onchain,
    });
  } catch (err) {
    req.log.error({ err }, "Vault fetch error");
    res.json({ vault: null, onchain: null });
  }
});

// ─── GET /vault/pool/pda ──────────────────────────────────────────────────────

router.get("/vault/pool/pda", (_req, res): void => {
  try {
    const [pda] = derivePoolPda();
    res.json({ pda: pda.toBase58() });
  } catch {
    res.status(500).json({ error: "Failed to derive pool PDA" });
  }
});

export default router;
