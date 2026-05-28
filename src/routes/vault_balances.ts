import { Router, type IRouter } from "express";
import { db, vaultBalancesTable, vaultsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { heliusRpcUrl } from "../lib/rpc";

const router: IRouter = Router();

const SIGNITO_VAULT_PROGRAM = "HyciDEYB9hXdmmLMexTHv2QYDaJmuZr1AF7sipBbVLLH";
const PROGRAM_ID = new PublicKey(SIGNITO_VAULT_PROGRAM);

// Cache program deployment status so we don't hit RPC on every request
let programDeployedCache: boolean | null = null;
let programDeployedAt = 0;
const CACHE_TTL_MS = 60_000;

async function checkProgramDeployed(): Promise<boolean> {
  if (programDeployedCache !== null && Date.now() - programDeployedAt < CACHE_TTL_MS) {
    return programDeployedCache;
  }
  try {
    const res = await fetch(heliusRpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "getAccountInfo",
        params: [SIGNITO_VAULT_PROGRAM, { encoding: "base64" }],
        id: 1,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { result?: { value?: { owner?: string } | null } };
    const owner = data.result?.value?.owner ?? "";
    const deployed = owner === "BPFLoaderUpgradeab1e11111111111111111111111";
    programDeployedCache = deployed;
    programDeployedAt = Date.now();
    return deployed;
  } catch {
    return programDeployedCache ?? false;
  }
}

// UserState layout (Anchor account, lib/db/src/schema/user.rs):
//   [0..8]   discriminator (8 bytes)
//   [8..40]  stoken_ata (Pubkey, 32 bytes)
//   [40..72] current_ots_hash ([u8; 32])
//   [72]     chain_depth (u8)
//   [73..81] deposited (u64, little-endian)
//   [81]     bump (u8)
const DEPOSITED_OFFSET = 73;
const CHAIN_DEPTH_OFFSET = 72;

async function fetchOnchainUserState(
  stokenAccount: string,
): Promise<{ depositedSol: number; chainDepth: number } | null> {
  try {
    const stokenAtaPk = new PublicKey(stokenAccount);
    const [userStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_state"), stokenAtaPk.toBuffer()],
      PROGRAM_ID,
    );
    const res = await fetch(heliusRpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "getAccountInfo",
        params: [userStatePda.toBase58(), { encoding: "base64" }],
        id: 2,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as {
      result?: { value?: { data?: [string, string] } | null };
    };
    const b64 = data.result?.value?.data?.[0];
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 82) return null;
    const depositedLamports = buf.readBigUInt64LE(DEPOSITED_OFFSET);
    const chainDepth = buf[CHAIN_DEPTH_OFFSET] ?? 0;
    return {
      depositedSol: Number(depositedLamports) / 1e9,
      chainDepth,
    };
  } catch {
    return null;
  }
}

router.get("/vault-balances/:wallet", async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  const raw = Array.isArray(req.params.wallet) ? req.params.wallet[0] : req.params.wallet;
  const wallet = raw as string;

  try {
    const [rows, vaultRows, programDeployed] = await Promise.all([
      db.select().from(vaultBalancesTable).where(eq(vaultBalancesTable.wallet, wallet)),
      db.select().from(vaultsTable).where(eq(vaultsTable.wallet, wallet)).limit(1),
      checkProgramDeployed(),
    ]);

    const vault = vaultRows[0] ?? null;

    // Fetch on-chain user_state via Helius (source of truth for deposited + chain_depth)
    let onchainState: { depositedSol: number; chainDepth: number } | null = null;
    if (vault?.stokenAccount) {
      onchainState = await fetchOnchainUserState(vault.stokenAccount);
    }

    const balances = rows.map((r) => {
      // Use on-chain deposited amount when available; it reflects the current
      // UserState.deposited value which is decremented by burn_and_queue on every
      // unshield or ZK send. The DB shieldedAmount is a stale write-time snapshot.
      // sSOL is stored as token="sSOL" in DB, not "SOL", so match both.
      const shieldedAmount =
        onchainState !== null && (r.token === "SOL" || r.token === "sSOL")
          ? onchainState.depositedSol
          : parseFloat(r.shieldedAmount ?? "0");
      return {
        token: r.token,
        mint: r.mint,
        shieldedAmount,
        decimals: r.decimals,
        updatedAt: r.updatedAt.toISOString(),
      };
    });

    res.json({
      wallet,
      balances,
      programDeployed,
      onchainChainDepth: onchainState?.chainDepth ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "VaultBalances fetch error");
    res.json({ wallet, balances: [], programDeployed: false, onchainChainDepth: null });
  }
});

export default router;
