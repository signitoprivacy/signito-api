/**
 * SignitoRelay: fee payer module
 *
 * Loads the relayer keypair once at startup from RELAYER_PRIVATE_KEY (base58).
 * Exposes helpers for: rate limiting, transaction validation, fee-payer co-signing.
 *
 * Security properties:
 *   - The secret key never leaves this module or the process.
 *   - The public key is safe to expose via GET /relay/info.
 *   - If the key leaks: only the relayer SOL (fee pool) is at risk.
 *     User shielded funds are protected by vault codes independently.
 */

import { Keypair, VersionedTransaction, Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "./logger.js";
import { heliusRpcUrl } from "./rpc.js";
import { getActiveSolanaProgramId } from "./solana-program.js";

// ─── Keypair ────────────────────────────────────────────────────────────────

function loadKeypair(): Keypair | null {
  const raw = process.env.RELAYER_PRIVATE_KEY;
  if (!raw) {
    logger.warn("RELAYER_PRIVATE_KEY not set, gasless relay disabled");
    return null;
  }
  try {
    const secretKey = bs58.decode(raw);
    const kp = Keypair.fromSecretKey(secretKey);
    logger.info({ pubkey: kp.publicKey.toBase58() }, "SignitoRelay keypair loaded");
    return kp;
  } catch (err) {
    logger.error({ err }, "Failed to load RELAYER_PRIVATE_KEY, check base58 encoding");
    return null;
  }
}

export const relayerKeypair: Keypair | null = loadKeypair();

export function relayerPubkey(): string | null {
  return relayerKeypair?.publicKey.toBase58() ?? null;
}

export function relayerReady(): boolean {
  return relayerKeypair !== null;
}

// ─── Connection (for simulation + balance) ──────────────────────────────────

export function getRpcUrl(): string {
  return heliusRpcUrl();
}

export function getConnection(): Connection {
  return new Connection(heliusRpcUrl(), "confirmed");
}

const SOLANA_STATUS_POLL_INTERVAL_MS = 60_000;
const SOLANA_STATUS_CACHE_TTL_MS = 60_000;

export type SolanaSignatureStatus = {
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  err: unknown | null;
  slot: number | null;
};

const solanaSignatureStatusCache = new Map<
  string,
  { checkedAt: number; status: SolanaSignatureStatus | null }
>();

/**
 * Read signature status at most once per signature per minute across API
 * handlers and background reconcilers. UI polling can safely read the cached
 * result without amplifying Solana RPC traffic.
 */
export async function getSolanaSignatureStatus(
  connection: Connection,
  signature: string,
): Promise<SolanaSignatureStatus | null> {
  const cached = solanaSignatureStatusCache.get(signature);
  if (cached && Date.now() - cached.checkedAt < SOLANA_STATUS_CACHE_TTL_MS) {
    return cached.status;
  }

  try {
    const result = await connection.getSignatureStatuses(
      [signature],
      { searchTransactionHistory: true },
    );
    const raw = result.value[0];
    const status = raw
      ? {
          confirmationStatus: raw.confirmationStatus ?? null,
          err: raw.err ?? null,
          slot: raw.slot ?? null,
        }
      : null;
    solanaSignatureStatusCache.set(signature, { checkedAt: Date.now(), status });
    return status;
  } catch (error) {
    if (cached) return cached.status;
    throw error;
  }
}

setInterval(() => {
  const expiry = Date.now() - 10 * 60_000;
  for (const [signature, cached] of solanaSignatureStatusCache) {
    if (cached.checkedAt < expiry) solanaSignatureStatusCache.delete(signature);
  }
}, 60_000);

/**
 * Reconcile a submitted Solana signature. RPC outages and absent receipts are
 * pending/unknown states, not a reason to submit a replacement transaction.
 */
export async function waitForSolanaSignature(
  connection: Connection,
  signature: string,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const status = await getSolanaSignatureStatus(connection, signature);
      if (status?.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
      }
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return;
      }
      logger.info(
        { signature, attempt, nextPollMs: SOLANA_STATUS_POLL_INTERVAL_MS },
        "Solana transaction is pending; status will be checked again",
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Transaction failed on-chain:")) {
        throw error;
      }
      logger.warn(
        { signature, attempt, nextPollMs: SOLANA_STATUS_POLL_INTERVAL_MS, error },
        "Solana transaction status RPC unavailable; status will be checked again",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SOLANA_STATUS_POLL_INTERVAL_MS));
  }
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────
// Simple in-memory: max 10 TX per wallet per hour.
// Resets on server restart. Upgrade to Redis for production scale.

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX_WALLET = 10;       // per wallet address
export const RATE_MAX_IP = 20;    // per IP (looser, catches bots without multiple wallets)

interface RateEntry {
  count: number;
  resetAt: number;
}

const rateMap = new Map<string, RateEntry>();

export function checkRateLimit(
  key: string,
  max: number = RATE_MAX_WALLET
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateMap.get(key);

  if (!entry || now >= entry.resetAt) {
    const resetAt = now + RATE_WINDOW_MS;
    rateMap.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: max - 1, resetAt };
  }

  if (entry.count >= max) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, remaining: max - entry.count, resetAt: entry.resetAt };
}

// Clean up expired entries periodically (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateMap.entries()) {
    if (now >= entry.resetAt) rateMap.delete(key);
  }
}, 10 * 60 * 1000);

// ─── Program Allowlist ───────────────────────────────────────────────────────
// Only allow transactions that invoke known programs.
// Add Signito program IDs here when deployed.

export const ALLOWED_PROGRAMS = new Set<string>([
  "11111111111111111111111111111111",               // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  // Token-2022 (sToken)
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1e",   // Associated Token Account
  "ComputeBudget111111111111111111111111111111",    // Compute Budget
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",  // Memo
  "Ed25519SigVerify111111111111111111111111111",    // Ed25519 precompile
  "5gbaenRHg2YK6X8WMMQZevD55bJ7fvr4V8E8e1feDt5D", // signito_vault (devnet)
  getActiveSolanaProgramId(), // approved active signito_vault program
]);

// ─── Max fee guard ────────────────────────────────────────────────────────────
// Reject transactions that would cost more than 0.005 SOL in fees.
// Protects the relayer from expensive transactions.
export const MAX_FEE_LAMPORTS = 5_000_000; // 0.005 SOL

// ─── Transaction parsing and validation ─────────────────────────────────────

export interface ParsedRelayTx {
  tx: VersionedTransaction;
  feePayer: PublicKey;
  programIds: string[];
}

/**
 * Parse a base64-encoded transaction and validate:
 *   1. Fee payer is the relayer keypair (gasless mode)
 *   2. All invoked programs are in the allowlist
 * Returns the parsed tx or throws with a descriptive error.
 */
export function parseAndValidateTx(base64Tx: string, requireFeePayer = true): ParsedRelayTx {
  let txBytes: Buffer;
  try {
    txBytes = Buffer.from(base64Tx, "base64");
  } catch {
    throw new Error("Transaction is not valid base64");
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(new Uint8Array(txBytes));
  } catch {
    throw new Error("Transaction deserialization failed. Must be a VersionedTransaction.");
  }

  const keys = tx.message.staticAccountKeys;
  if (keys.length === 0) {
    throw new Error("Transaction has no accounts");
  }

  const feePayer = keys[0];

  // Fee payer check: only required when relayer key is configured
  if (requireRelayerFeePayer() && requireFeePayer) {
    if (!relayerKeypair) throw new Error("SignitoRelay not configured");
    if (!feePayer.equals(relayerKeypair.publicKey)) {
      throw new Error(
        `Fee payer must be SignitoRelay (${relayerKeypair.publicKey.toBase58()}). ` +
        `Got: ${feePayer.toBase58()}`
      );
    }
  }

  // Program allowlist check
  const instructions = tx.message.compiledInstructions;
  const programIds: string[] = [];
  for (const ix of instructions) {
    const programId = keys[ix.programIdIndex]?.toBase58();
    if (!programId) throw new Error("Invalid instruction: program index out of range");
    programIds.push(programId);
    if (!ALLOWED_PROGRAMS.has(programId)) {
      throw new Error(`Program not in allowlist: ${programId}`);
    }
  }

  return { tx, feePayer, programIds };
}

function requireRelayerFeePayer(): boolean {
  // Only enforce if relayer is configured. If not configured, pass through.
  return relayerKeypair !== null;
}

/**
 * Co-sign the transaction as fee payer.
 * The user has already signed their instructions, this adds the relayer sig.
 */
export function coSignAsFeePayerAndSerialize(tx: VersionedTransaction): string {
  if (!relayerKeypair) throw new Error("SignitoRelay keypair not available");
  tx.sign([relayerKeypair]);
  return Buffer.from(tx.serialize()).toString("base64");
}

/**
 * Simulate the transaction before spending a real fee.
 * Returns an error string if simulation fails, or null if ok.
 */
export async function simulateTx(tx: VersionedTransaction): Promise<string | null> {
  try {
    const conn = getConnection();
    const sim = await conn.simulateTransaction(tx, {
      commitment: "processed",
      innerInstructions: true,
    });
    if (sim.value.err) {
      const logs = sim.value.logs ?? [];
      logger.warn({ err: sim.value.err, logs }, "Relay: simulation failed with logs");
      const logStr = logs.length > 0 ? ` | logs: ${logs.slice(-8).join(" | ")}` : "";
      return `Simulation failed: ${JSON.stringify(sim.value.err)}${logStr}`;
    }
    return null;
  } catch (err) {
    logger.warn({ err }, "Transaction simulation error (non-fatal)");
    return null;
  }
}

/**
 * Get the relayer SOL balance in lamports.
 */
export async function getRelayerBalance(): Promise<number> {
  if (!relayerKeypair) return 0;
  try {
    const conn = getConnection();
    return await conn.getBalance(relayerKeypair.publicKey, "confirmed");
  } catch {
    return -1;
  }
}
