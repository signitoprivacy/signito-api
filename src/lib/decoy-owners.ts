import { randomBytes } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./relayer.js";
import { logger } from "./logger.js";

// Cache of wallet addresses from real DEX traders on mainnet.
// These are fee payers of transactions involving known DEX programs (Jupiter, Raydium, Orca, etc.).
// Fee payers of DEX swaps are always real human/trader wallets -- never PDAs or programs.
let ownerCache: string[] = [];
let cacheRefreshedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_CACHE_SIZE = 50;

// Known DEX program IDs on Solana mainnet.
// A transaction containing any of these is a real DEX swap by a real trader.
const DEX_PROGRAMS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter v6
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",   // Jupiter v4
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium AMM v4
  "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h",  // Raydium AMM v5
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpool
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",  // Orca v2
  "Eo7WjKq67rjJQDd81HDcB5e5y2r9gRovTEoP6yYVRmpP",  // Meteora DLMM
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",   // Meteora LB
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  // Raydium CAMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",  // Raydium CPMM
]);

// Addresses that must never appear as display_owner regardless of source.
const BLOCKLIST = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bsn",
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

function isLikelyProgram(address: string): boolean {
  if (address.startsWith("Sysvar")) return true;
  if (address.length < 40) return true;
  return false;
}

// Refresh cache by sampling recent blocks and extracting fee payers of DEX swap transactions.
// Only transactions that involve a known DEX program qualify -- this guarantees the fee payer
// is a real human trader wallet, not a bot scheduler, CEX system, or PDA.
async function refreshOwnerCache(): Promise<void> {
  // Always update timestamp first to prevent hammering RPC on repeated failures.
  cacheRefreshedAt = Date.now();
  try {
    const conn = getConnection();
    const slot = await conn.getSlot("finalized");

    const traders = new Set<string>();
    const BLOCKS_TO_SAMPLE = 5;

    for (let i = 0; i < BLOCKS_TO_SAMPLE; i++) {
      const targetSlot = slot - 3 - i;
      try {
        const block = await conn.getBlock(targetSlot, {
          maxSupportedTransactionVersion: 0,
          transactionDetails: "accounts",
          rewards: false,
        });
        if (!block) continue;

        for (const tx of block.transactions ?? []) {
          // transactionDetails:"accounts" gives tx.transaction.accountKeys[]
          // Each entry: { pubkey: PublicKey, signer: boolean, writable: boolean }
          const accountKeys = (tx.transaction as unknown as {
            accountKeys?: Array<{ pubkey: PublicKey }>;
          }).accountKeys;
          if (!accountKeys || accountKeys.length === 0) continue;

          // Check if any account in this TX is a known DEX program
          const hasDex = accountKeys.some((k) => {
            const s = k.pubkey instanceof PublicKey
              ? k.pubkey.toBase58()
              : String(k.pubkey);
            return DEX_PROGRAMS.has(s);
          });
          if (!hasDex) continue;

          // Fee payer = index 0, guaranteed to be a real signing wallet
          const feePayer = accountKeys[0]?.pubkey;
          if (!feePayer) continue;
          const str = feePayer instanceof PublicKey
            ? feePayer.toBase58()
            : String(feePayer);

          if (
            str.length >= 40 &&
            str.length <= 44 &&
            !BLOCKLIST.has(str) &&
            !isLikelyProgram(str)
          ) {
            traders.add(str);
          }
        }
      } catch {
        // Skip unavailable blocks silently
      }
    }

    const validated = Array.from(traders).filter((pk) => {
      try { new PublicKey(pk); return true; } catch { return false; }
    });

    if (validated.length >= 10) {
      ownerCache = validated;
      logger.info({ count: ownerCache.length, slot }, "decoy-owners: cache refreshed from DEX traders");
    } else {
      logger.warn({ count: validated.length, slot }, "decoy-owners: too few DEX traders found in blocks");
    }
  } catch (err) {
    logger.warn({ err }, "decoy-owners: cache refresh failed");
  }
}

// Returns one random display_owner from real DEX trader wallets.
export async function pickDecoyOwner(): Promise<string> {
  if (Date.now() - cacheRefreshedAt > CACHE_TTL_MS || ownerCache.length < MIN_CACHE_SIZE) {
    await refreshOwnerCache();
  }
  if (ownerCache.length === 0) {
    // Emergency fallback: random pubkey (better than a known program address)
    return new PublicKey(randomBytes(32)).toBase58();
  }
  return ownerCache[Math.floor(Math.random() * ownerCache.length)];
}

// Pick N distinct display_owner addresses (no duplicates within one TX).
export async function pickDecoyOwners(count: number): Promise<string[]> {
  if (Date.now() - cacheRefreshedAt > CACHE_TTL_MS || ownerCache.length < MIN_CACHE_SIZE) {
    await refreshOwnerCache();
  }

  const pool = ownerCache.length > 0 ? ownerCache : [];
  const copy = pool.slice();
  const result: string[] = [];

  for (let i = 0; i < Math.min(count, copy.length); i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
    result.push(copy[i]);
  }

  while (result.length < count) {
    result.push(new PublicKey(randomBytes(32)).toBase58());
  }

  return result;
}
