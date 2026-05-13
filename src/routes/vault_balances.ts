import { Router, type IRouter } from "express";
import { db, vaultBalancesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { heliusRpcUrl } from "../lib/rpc";

const router: IRouter = Router();

const SIGNITO_VAULT_PROGRAM = "9PibgJMUa3zXVd7YWJEJ8UQ14A7z2J3qZ7QDvRW38XeD";

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
    // BPFLoaderUpgradeable programs have this owner
    const deployed = owner === "BPFLoaderUpgradeab1e11111111111111111111111";
    programDeployedCache = deployed;
    programDeployedAt = Date.now();
    return deployed;
  } catch {
    return programDeployedCache ?? false;
  }
}

router.get("/vault-balances/:wallet", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.wallet) ? req.params.wallet[0] : req.params.wallet;
  const wallet = raw as string;

  try {
    const [rows, programDeployed] = await Promise.all([
      db.select().from(vaultBalancesTable).where(eq(vaultBalancesTable.wallet, wallet)),
      checkProgramDeployed(),
    ]);

    const balances = rows.map((r) => ({
      token: r.token,
      mint: r.mint,
      shieldedAmount: parseFloat(r.shieldedAmount ?? "0"),
      decimals: r.decimals,
      updatedAt: r.updatedAt.toISOString(),
    }));

    res.json({ wallet, balances, programDeployed });
  } catch (err) {
    req.log.error({ err }, "VaultBalances fetch error");
    res.json({ wallet, balances: [], programDeployed: false });
  }
});

export default router;
