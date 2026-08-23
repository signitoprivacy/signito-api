import { Router, type IRouter } from "express";
import {
  getActiveSolanaProgramId,
  getSolanaCluster,
} from "../lib/solana-program";

const router: IRouter = Router();

async function proxyRpc(
  req: Parameters<Parameters<typeof router.post>[1]>[0],
  res: Parameters<Parameters<typeof router.post>[1]>[1],
  url: string
): Promise<void> {
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    req.log.error({ err }, "RPC proxy error");
    res.status(502).json({ error: "RPC proxy error" });
  }
}

// POST /rpc/mainnet -- proxies to Helius mainnet (keeps API key server-side)
router.post("/rpc/mainnet", async (req, res): Promise<void> => {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) {
    res.status(503).json({ error: "HELIUS_API_KEY not configured" });
    return;
  }
  await proxyRpc(req, res, `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`);
});

// GET /rpc/mainnet -- health-check / preflight used by wallet adapters
router.get("/rpc/mainnet", (_req, res): void => {
  res.json({ ok: true });
});

// POST /rpc/devnet -- proxies to Helius devnet if key present, else public devnet
router.post("/rpc/devnet", async (req, res): Promise<void> => {
  const heliusKey = process.env.HELIUS_API_KEY;
  const url = heliusKey
    ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}`
    : "https://api.devnet.solana.com";
  await proxyRpc(req, res, url);
});

// GET /rpc/devnet -- health-check / preflight used by wallet adapters
router.get("/rpc/devnet", (_req, res): void => {
  res.json({ ok: true });
});

// GET /rpc/cluster -- tells frontend which cluster is active and which program ID to use
router.get("/rpc/cluster", (_req, res): void => {
  const cluster = getSolanaCluster();
  const programId = getActiveSolanaProgramId();
  res.json({ cluster, programId });
});

export default router;
