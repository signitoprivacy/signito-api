import { Router, type IRouter } from "express";
import { heliusRpcUrl } from "../lib/rpc";
import { RelayBody } from "@workspace/api-zod";
import {
  relayerKeypair,
  relayerReady,
  checkRateLimit,
  parseAndValidateTx,
  coSignAsFeePayerAndSerialize,
  simulateTx,
  RATE_MAX_IP,
} from "../lib/relayer.js";

const router: IRouter = Router();

// POST /relay
//
// Gasless relay: accepts a VersionedTransaction where fee_payer = SignitoRelay,
// already signed by the user. The relayer:
//   1. Rate-limits by wallet (10 TX/hr)
//   2. Validates the transaction (fee payer, program allowlist)
//   3. Simulates the transaction (catches errors before paying fees)
//   4. Co-signs as fee payer
//   5. Broadcasts to Helius Mainnet
//
// If RELAYER_PRIVATE_KEY is not set, falls back to plain broadcast (no co-sign).
// In that case the caller must sign and pay fees themselves.
router.post("/relay", async (req, res): Promise<void> => {
  const parsed = RelayBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", detail: parsed.error.message });
    return;
  }

  const { transaction: base64Tx, wallet } = parsed.data;

  // ── Rate limiting ────────────────────────────────────────────────────────
  // Two independent counters: per wallet (primary) and per IP (secondary).
  // Both must pass. Prefix prevents key collisions between the two namespaces.
  const ipKey = "ip:" + (req.ip ?? "unknown");
  const walletKey = wallet ? "wallet:" + wallet : ipKey;
  const rlWallet = checkRateLimit(walletKey);
  const rlIp = walletKey !== ipKey ? checkRateLimit(ipKey, RATE_MAX_IP) : rlWallet;
  const rl = !rlWallet.allowed ? rlWallet : !rlIp.allowed ? rlIp : rlWallet;
  if (!rl.allowed) {
    res.status(429).json({
      error: "Rate limit exceeded. Max 10 transactions per hour per wallet.",
      resetAt: new Date(rl.resetAt).toISOString(),
    });
    return;
  }

  // ── Gasless path: validate, co-sign, broadcast ───────────────────────────
  if (relayerReady()) {
    let parsedTx;
    try {
      parsedTx = parseAndValidateTx(base64Tx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.warn({ msg, wallet }, "Relay: transaction validation failed");
      res.status(400).json({ error: msg, rlRemaining: rl.remaining });
      return;
    }

    // Simulate before spending a real fee
    const simError = await simulateTx(parsedTx.tx);
    if (simError) {
      req.log.warn({ simError, wallet }, "Relay: simulation failed");
      res.status(400).json({ error: simError, rlRemaining: rl.remaining });
      return;
    }

    // Co-sign as fee payer
    let signedBase64: string;
    try {
      signedBase64 = coSignAsFeePayerAndSerialize(parsedTx.tx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ msg }, "Relay: fee payer co-sign failed");
      res.status(500).json({ error: "Fee payer signing failed", rlRemaining: rl.remaining });
      return;
    }

    req.log.info(
      { wallet, programs: parsedTx.programIds, rlRemaining: rl.remaining },
      "Relay: co-signed as fee payer, broadcasting"
    );

    // Broadcast the fully-signed transaction
    const sig = await broadcastBase64(req, signedBase64);
    if (sig.error) {
      res.status(400).json({ error: sig.error, rlRemaining: rl.remaining });
      return;
    }
    res.json({ signature: sig.result, gasless: true, rlRemaining: rl.remaining });
    return;
  }

  // ── Fallback: plain broadcast (no fee payer co-sign) ────────────────────
  // Used when RELAYER_PRIVATE_KEY is not configured.
  // The caller must have signed + funded fees themselves.
  req.log.info({ wallet }, "Relay: plain broadcast (gasless not configured)");
  const sig = await broadcastBase64(req, base64Tx);
  if (sig.error) {
    res.status(400).json({ error: sig.error, rlRemaining: rl.remaining });
    return;
  }
  res.json({ signature: sig.result, gasless: false, rlRemaining: rl.remaining });
});

// ─── Broadcast helper ────────────────────────────────────────────────────────

async function broadcastBase64(
  req: Parameters<typeof router.post>[1] extends (req: infer R, ...args: unknown[]) => unknown ? R : never,
  base64Tx: string
): Promise<{ result: string; error: null } | { result: null; error: string }> {
  const url = heliusRpcUrl();

  try {
    const rpcRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "sendTransaction",
        params: [base64Tx, { encoding: "base64", preflightCommitment: "processed" }],
        id: 1,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = (await rpcRes.json()) as {
      result?: string;
      error?: { message: string; code?: number };
    };

    if (data.error) {
      req.log.warn({ error: data.error }, "Relay: RPC broadcast error");
      return { result: null, error: data.error.message };
    }

    req.log.info({ sig: data.result }, "Relay: broadcast successful");
    return { result: data.result ?? "", error: null };
  } catch (err) {
    req.log.error({ err }, "Relay: broadcast exception");
    return { result: null, error: "Broadcast failed, network error" };
  }
}

export default router;
