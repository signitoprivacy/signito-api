import { Keypair, PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db, mixWalletsTable } from "@workspace/db";
import {
  buildDecoyShieldIx,
  buildCloseDecoyIx,
  buildVersionedTx,
  deriveUserStatePda,
  fetchPoolState,
} from "@workspace/program";
import { getConnection, relayerKeypair } from "./relayer.js";
import { logger } from "./logger.js";

// Pool health targets (keypairs only, no on-chain state)
const POOL_TARGET = 400;
const POOL_REFILL_THRESHOLD = 100;
const POOL_REFILL_AMOUNT = 200;
const POOL_CHECK_INTERVAL_MS = 60_000;        // keypair health check every 60s
const CLOSE_DEPLETED_INTERVAL_MS = 10 * 60_000; // close depleted accounts every 10 min
const CLOSE_DECOY_BATCH = 10;                 // max pairs per close_decoy TX

let isRefilling = false;
let isClosing = false;
const activeProvisioning = new Map<string, Promise<number>>();

// ─── count ready keypairs ─────────────────────────────────────────────────────

async function countReady(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mixWalletsTable)
    .where(eq(mixWalletsTable.status, "ready"));
  return row?.count ?? 0;
}

// ─── generate keypairs and store in DB (no on-chain TX) ───────────────────────
// The secret key is stored so vault.ts can sign decoy_shield at TX time.
// On-chain state is created atomically with a real user action, never upfront.

async function generateKeypairs(count: number): Promise<number> {
  let generated = 0;
  for (let i = 0; i < count; i++) {
    try {
      const kp = Keypair.generate();
      const displayOwnerKp = Keypair.generate();
      await db.insert(mixWalletsTable).values({
        stokenAta: kp.publicKey.toBase58(),
        secretKey: Buffer.from(kp.secretKey).toString("base64"),
        displayOwner: displayOwnerKp.publicKey.toBase58(),
        displayOwnerSecret: Buffer.from(displayOwnerKp.secretKey).toString("base64"),
        amountLamports: "0",
        status: "ready",
      }).onConflictDoNothing();
      generated++;
    } catch (err) {
      logger.warn({ err }, "mix-worker: keypair insert failed");
    }
  }
  return generated;
}

/**
 * Creates on-chain decoys for a private execution that cannot yet draw a full
 * privacy set from the available pool. Every instruction is signed and funded
 * by the operational relayer; no connected user wallet participates.
 */
export async function provisionMixDecoys(
  count: number,
  amountLamports: bigint,
): Promise<number> {
  if (count <= 0) return 0;
  if (!relayerKeypair) throw new Error("Relayer is not configured.");

  const key = amountLamports.toString();
  const running = activeProvisioning.get(key);
  if (running) return running;

  const job = (async () => {
    const conn = getConnection();
    const poolState = await fetchPoolState(conn);
    if (!poolState) throw new Error("Pool is not initialized.");

    let created = 0;
    for (let index = 0; index < count; index += 1) {
      const decoyKp = Keypair.generate();
      const displayOwnerKp = Keypair.generate();
      const ix = buildDecoyShieldIx(
        relayerKeypair.publicKey,
        displayOwnerKp.publicKey,
        poolState.mintStoken,
        decoyKp.publicKey,
        {
          otsTip: randomBytes(32),
          chainDepth: 8 + Math.floor(Math.random() * 57),
          amount: amountLamports,
        },
      );

      const tx = await buildVersionedTx(conn, relayerKeypair.publicKey, [ix]);
      tx.sign([relayerKeypair, decoyKp, displayOwnerKp]);
      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      const deadline = Date.now() + 45_000;
      let confirmed = false;
      while (Date.now() < deadline) {
        const status = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
        if (status?.err) throw new Error(`Decoy preparation failed on-chain: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          confirmed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      }
      if (!confirmed) throw new Error("Decoy preparation confirmation timed out.");

      await db.insert(mixWalletsTable).values({
        stokenAta: decoyKp.publicKey.toBase58(),
        displayOwner: displayOwnerKp.publicKey.toBase58(),
        displayOwnerSecret: Buffer.from(displayOwnerKp.secretKey).toString("base64"),
        amountLamports: amountLamports.toString(),
        status: "available",
      }).onConflictDoNothing();
      created += 1;
      logger.info({ sig, created, requested: count }, "mix-worker: operational decoy prepared");
    }
    return created;
  })();

  activeProvisioning.set(key, job);
  try {
    return await job;
  } finally {
    activeProvisioning.delete(key);
  }
}

// ─── recover stale in_use wallets (crashed mid-TX) ───────────────────────────

async function recoverStale(): Promise<void> {
  const staleThreshold = new Date(Date.now() - 5 * 60_000);
  const stale = await db.select().from(mixWalletsTable).where(eq(mixWalletsTable.status, "in_use"));
  const toRecover = stale.filter((r) => r.lastUsedAt && r.lastUsedAt < staleThreshold);
  if (toRecover.length === 0) return;
  for (const row of toRecover) {
    // Recover to "ready" if secret key exists, otherwise "available"
    const status = row.secretKey ? "ready" : "available";
    await db.update(mixWalletsTable).set({ status }).where(eq(mixWalletsTable.id, row.id));
  }
  logger.info({ recovered: toRecover.length }, "mix-worker: recovered stale in_use wallets");
}

// ─── close depleted decoy accounts and recover rent ──────────────────────────
// Sends close_decoy TX in a block separate from any user action.
// pool_pda (close_authority) closes each depleted stoken_ata and its user_state PDA.
// Rent returns to relayer. Net cost of the entire mix layer = 0.

export async function runCloseDepletedDecoys(): Promise<{ closed: number; sig?: string; error?: string }> {
  if (!relayerKeypair) return { closed: 0, error: "Relayer not configured." };
  if (isClosing) return { closed: 0, error: "Close job already running." };

  isClosing = true;
  try {
    const depleted = await db
      .select()
      .from(mixWalletsTable)
      .where(eq(mixWalletsTable.status, "depleted"))
      .limit(CLOSE_DECOY_BATCH);

    if (depleted.length === 0) {
      logger.debug("mix-worker: no depleted accounts to close");
      return { closed: 0 };
    }

    const conn = getConnection();

    // Filter out accounts that no longer exist on-chain (already closed by
    // a previous run or drained externally). Sending close_decoy on a missing
    // account causes "UninitializedAccount" and reverts the whole TX.
    const stokenPks = depleted.map((row) => new PublicKey(row.stokenAta));
    const accountInfos = await conn.getMultipleAccountsInfo(stokenPks, "confirmed");
    const existingIndices = depleted.map((_, i) => accountInfos[i] !== null);
    const live = depleted.filter((_, i) => existingIndices[i]);
    const dead = depleted.filter((_, i) => !existingIndices[i]);

    // Delete DB rows for accounts that are already gone on-chain
    if (dead.length > 0) {
      for (const row of dead) {
        await db.delete(mixWalletsTable).where(eq(mixWalletsTable.id, row.id));
      }
      logger.info({ count: dead.length }, "mix-worker: removed already-closed accounts from DB");
    }

    if (live.length === 0) {
      logger.debug("mix-worker: no live depleted accounts to close after on-chain filter");
      return { closed: 0 };
    }

    // Filter out accounts with non-zero token balance. These are from a previous
    // mint that lacked PermanentDelegate -- they cannot be burned or closed via
    // close_decoy (which requires zero balance). Remove from DB so they don't
    // block future close runs; their rent is lost but the protocol stays clean.
    const closeable: typeof live = [];
    for (const row of live) {
      try {
        const bal = await conn.getTokenAccountBalance(new PublicKey(row.stokenAta), "confirmed");
        const amount = BigInt(bal.value.amount);
        if (amount > 0n) {
          await db.delete(mixWalletsTable).where(eq(mixWalletsTable.id, row.id));
          logger.info({ stokenAta: row.stokenAta }, "mix-worker: removed non-zero-balance account (legacy mint, no PermanentDelegate)");
        } else {
          closeable.push(row);
        }
      } catch {
        // If balance check fails, skip this account conservatively
        closeable.push(row);
      }
    }

    if (closeable.length === 0) {
      logger.debug("mix-worker: all live depleted accounts have non-zero balance, removed from DB");
      return { closed: 0 };
    }

    const pairs = closeable.map((row) => ({
      stokenAta: new PublicKey(row.stokenAta),
      userState: deriveUserStatePda(new PublicKey(row.stokenAta))[0],
    }));

    const ix = buildCloseDecoyIx(relayerKeypair.publicKey, pairs);
    const tx = await buildVersionedTx(conn, relayerKeypair.publicKey, [ix]);
    tx.sign([relayerKeypair]);

    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    const deadline = Date.now() + 30_000;
    let confirmed = false;
    while (Date.now() < deadline) {
      const statuses = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const s = statuses.value[0];
      if (s?.err) {
        logger.warn({ sig, err: s.err }, "mix-worker: close_decoy TX failed on-chain");
        return { closed: 0, sig, error: "TX failed on-chain" };
      }
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
        confirmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }

    if (!confirmed) {
      logger.warn({ sig, count: depleted.length }, "mix-worker: close_decoy TX not confirmed within 30s");
      return { closed: 0, sig, error: "TX not confirmed" };
    }

    // TX confirmed: delete closed rows from DB (on-chain accounts no longer exist)
    for (const row of closeable) {
      await db.delete(mixWalletsTable).where(eq(mixWalletsTable.id, row.id));
    }

    logger.info(
      { sig, count: closeable.length },
      "mix-worker: depleted decoy accounts closed, rent recovered to relayer",
    );

    return { closed: closeable.length, sig };
  } catch (err) {
    logger.warn({ err }, "mix-worker: runCloseDepletedDecoys error");
    return { closed: 0, error: String(err) };
  } finally {
    isClosing = false;
  }
}

// ─── main pool-health tick ────────────────────────────────────────────────────

async function runPoolCheck(): Promise<void> {
  if (!relayerKeypair) return;
  if (isRefilling) return;

  try {
    await recoverStale();

    const ready = await countReady();

    if (ready >= POOL_REFILL_THRESHOLD) {
      logger.debug({ ready }, "mix-worker: pool healthy");
      return;
    }

    const toGenerate = Math.min(POOL_REFILL_AMOUNT, POOL_TARGET - ready);
    logger.info({ ready, toGenerate }, "mix-worker: generating keypairs");
    isRefilling = true;

    const generated = await generateKeypairs(toGenerate);
    const after = await countReady();
    logger.info({ before: ready, after, generated }, "mix-worker: keypair generation complete");
  } catch (err) {
    logger.warn({ err }, "mix-worker: tick error");
  } finally {
    isRefilling = false;
  }
}

// ─── public: start the worker ─────────────────────────────────────────────────

export function startMixPoolWorker(): void {
  logger.info({
    target: POOL_TARGET,
    threshold: POOL_REFILL_THRESHOLD,
    intervalMs: POOL_CHECK_INTERVAL_MS,
    closeIntervalMs: CLOSE_DEPLETED_INTERVAL_MS,
  }, "mix-worker: started (keypair-only mode, close_decoy rent recovery enabled)");

  void runPoolCheck();
  setInterval(() => { void runPoolCheck(); }, POOL_CHECK_INTERVAL_MS);

  // Schedule close_decoy runs: wait 2 minutes after startup before first run,
  // then every 10 minutes. This ensures the server is fully ready and avoids
  // triggering close_decoy at the same time as an in-flight shield/unshield.
  setTimeout(() => {
    void runCloseDepletedDecoys();
    setInterval(() => { void runCloseDepletedDecoys(); }, CLOSE_DEPLETED_INTERVAL_MS);
  }, 2 * 60_000);
}
