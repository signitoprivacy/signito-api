import { Router, type IRouter } from "express";

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
const PROGRAM_ID_DEVNET = "5gbaenRHg2YK6X8WMMQZevD55bJ7fvr4V8E8e1feDt5D";
const PROGRAM_ID_MAINNET = "HyciDEYB9hXdmmLMexTHv2QYDaJmuZr1AF7sipBbVLLH";

router.get("/rpc/cluster", (_req, res): void => {
  const cluster = process.env.SOLANA_CLUSTER ?? "mainnet";
  const programId = cluster === "devnet" ? PROGRAM_ID_DEVNET : PROGRAM_ID_MAINNET;
  res.json({ cluster, programId });
});

export default router;
