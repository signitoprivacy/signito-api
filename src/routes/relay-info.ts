import { Router, type IRouter } from "express";
import { relayerPubkey, relayerReady, getRelayerBalance, ALLOWED_PROGRAMS } from "../lib/relayer.js";

const router: IRouter = Router();

// GET /relay/info
// Returns the relayer public key, readiness status, and SOL balance.
// Clients use this to set fee_payer = feePayer before signing and sending a transaction.
router.get("/relay/info", async (req, res): Promise<void> => {
  const pubkey = relayerPubkey();
  const ready = relayerReady();
  const balanceLamports = ready ? await getRelayerBalance() : 0;

  if (balanceLamports !== -1 && balanceLamports < 50_000_000) {
    // 0.05 SOL: warn in logs
    req.log.warn(
      { balanceLamports, pubkey },
      "SignitoRelay balance low, top up required"
    );
  }

  res.json({
    feePayer: pubkey,
    ready,
    balanceLamports,
    balanceSol: balanceLamports / 1_000_000_000,
    allowedPrograms: Array.from(ALLOWED_PROGRAMS),
  });
});

export default router;
