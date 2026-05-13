import { Router, type IRouter } from "express";
import { heliusRpcUrl } from "../lib/rpc";

const router: IRouter = Router();

router.get("/status", async (req, res): Promise<void> => {
  const heliusKey = process.env.HELIUS_API_KEY;
  const mainnetUrl = heliusRpcUrl();

  const checks: Array<{ name: string; status: string; latency: number; detail: string | null }> = [];

  const rpcPayload = JSON.stringify({
    jsonrpc: "2.0",
    method: "getHealth",
    params: [],
    id: 1,
  });

  const rpcStart = Date.now();
  let rpcStatus = "ok";
  let rpcDetail: string | null = null;
  try {
    const rpcRes = await fetch(mainnetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rpcPayload,
      signal: AbortSignal.timeout(5000),
    });
    if (!rpcRes.ok) {
      rpcStatus = "error";
      rpcDetail = `HTTP ${rpcRes.status}`;
    } else {
      const data = (await rpcRes.json()) as { result?: string; error?: { message: string } };
      if (data.error) {
        rpcStatus = "error";
        rpcDetail = data.error.message;
      }
    }
  } catch (err) {
    rpcStatus = "error";
    rpcDetail = err instanceof Error ? err.message : "Unknown error";
  }
  checks.push({ name: "Solana RPC", status: rpcStatus, latency: Date.now() - rpcStart, detail: rpcDetail });

  let heliusStatus = "ok";
  let heliusDetail: string | null = null;
  const heliusStart = Date.now();
  if (!heliusKey) {
    heliusStatus = "error";
    heliusDetail = "HELIUS_API_KEY not configured";
    checks.push({ name: "Helius API", status: heliusStatus, latency: 0, detail: heliusDetail });
  } else {
    try {
      const heliusRes = await fetch(
        heliusRpcUrl(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "getHealth", params: [], id: 2 }),
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!heliusRes.ok) {
        heliusStatus = "error";
        heliusDetail = `HTTP ${heliusRes.status}`;
      }
    } catch (err) {
      heliusStatus = "error";
      heliusDetail = err instanceof Error ? err.message : "Unknown error";
    }
    checks.push({ name: "Helius API", status: heliusStatus, latency: Date.now() - heliusStart, detail: heliusDetail });
  }

  res.json({ checks, timestamp: new Date().toISOString() });
});

export default router;
