import { Router, type IRouter } from "express";
import { db, mixWalletsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import {
  buildDecoyShieldIx,
  buildAdminMintIx,
  buildVersionedTx,
  fetchPoolState,
  deriveUserStatePda,
} from "@workspace/program";
import { getConnection, relayerKeypair } from "../lib/relayer.js";
import { logger } from "../lib/logger.js";
import { pickDecoyOwner } from "../lib/decoy-owners.js";
import { runCloseDepletedDecoys } from "../lib/mix-pool-worker.js";

const router: IRouter = Router();

// ─── GET /admin/mix/status ────────────────────────────────────────────────────

router.get("/admin/mix/status", async (req, res): Promise<void> => {
  try {
    const all = await db.select().from(mixWalletsTable);
    const ready = all.filter((r) => r.status === "ready").length;
    const available = all.filter((r) => r.status === "available").length;
    const depleted = all.filter((r) => r.status === "depleted").length;
    const inUse = all.filter((r) => r.status === "in_use").length;
    res.json({ total: all.length, ready, available, depleted, inUse });
  } catch (err) {
    req.log.error({ err }, "mix/status error");
    res.status(500).json({ error: "Failed to fetch mix pool status" });
  }
});

// ─── POST /admin/mix/init ─────────────────────────────────────────────────────
// Create N new decoy accounts on-chain via decoy_shield and add them to pool.
// Body: { count: number (1..20), amountLamports: number }

router.post("/admin/mix/init", async (req, res): Promise<void> => {
  const count: number = Math.min(Number(req.body.count ?? 5), 20);
  const amountLamports: bigint = BigInt(req.body.amountLamports ?? 1_000_000_000);

  if (!relayerKeypair) {
    res.status(503).json({ error: "Relayer not configured." });
    return;
  }

  try {
    const conn = getConnection();
    const poolState = await fetchPoolState(conn);
    if (!poolState) {
      res.status(503).json({ error: "Pool not initialized." });
      return;
    }

    const mintPk = poolState.mintStoken;
    const created: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < count; i++) {
      const decoyKp       = Keypair.generate();
      const freshWalletKp = Keypair.generate();

      const randOtsTip = randomBytes(32);
      const chainDepth = 8 + Math.floor(Math.random() * 57); // 8..64 random

      try {
        const ix = buildDecoyShieldIx(
          relayerKeypair.publicKey,
          freshWalletKp.publicKey,
          mintPk,
          decoyKp.publicKey,
          { otsTip: randOtsTip, chainDepth, amount: amountLamports }
        );

        const tx = await buildVersionedTx(conn, relayerKeypair.publicKey, [ix]);
        tx.sign([relayerKeypair, decoyKp, freshWalletKp]);

        const sig = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });

        // Poll for confirmation
        const deadline = Date.now() + 45_000;
        let confirmed = false;
        while (Date.now() < deadline) {
          const statuses = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
          const s = statuses.value[0];
          if (s?.err) break;
          if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
            confirmed = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1200));
        }

        if (confirmed) {
          await db.insert(mixWalletsTable).values({
            stokenAta:          decoyKp.publicKey.toBase58(),
            displayOwner:       freshWalletKp.publicKey.toBase58(),
            displayOwnerSecret: Buffer.from(freshWalletKp.secretKey).toString("base64"),
            amountLamports:     amountLamports.toString(),
            status:             "available",
          }).onConflictDoNothing();
          created.push(decoyKp.publicKey.toBase58());
          logger.info({ sig, stokenAta: decoyKp.publicKey.toBase58() }, "mix/init: decoy account created");
        } else {
          failed.push(decoyKp.publicKey.toBase58());
          logger.warn({ sig, stokenAta: decoyKp.publicKey.toBase58() }, "mix/init: TX not confirmed");
        }
      } catch (txErr) {
        logger.warn({ txErr, i }, "mix/init: TX failed");
        failed.push(decoyKp.publicKey.toBase58());
      }

      // Small delay between TXs to avoid rate limiting
      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    res.json({ created: created.length, failed: failed.length, accounts: created });
  } catch (err) {
    req.log.error({ err }, "mix/init error");
    res.status(500).json({ error: "Failed to initialize mix pool" });
  }
});

// ─── POST /admin/mix/refill ───────────────────────────────────────────────────
// Re-mint sSOL to depleted decoy accounts via admin_mint.
// Body: { count: number (1..20), amountLamports: number }

router.post("/admin/mix/refill", async (req, res): Promise<void> => {
  const count: number = Math.min(Number(req.body.count ?? 5), 20);
  const amountLamports: bigint = BigInt(req.body.amountLamports ?? 1_000_000_000);

  if (!relayerKeypair) {
    res.status(503).json({ error: "Relayer not configured." });
    return;
  }

  try {
    const conn = getConnection();
    const poolState = await fetchPoolState(conn);
    if (!poolState) {
      res.status(503).json({ error: "Pool not initialized." });
      return;
    }

    const mintPk = poolState.mintStoken;

    const depleted = await db
      .select()
      .from(mixWalletsTable)
      .where(eq(mixWalletsTable.status, "depleted"))
      .limit(count);

    if (depleted.length === 0) {
      res.json({ refilled: 0, message: "No depleted accounts found." });
      return;
    }

    const refilled: string[] = [];
    const failed: string[] = [];

    for (const row of depleted) {
      try {
        const destPk = new PublicKey(row.stokenAta);
        const ix = buildAdminMintIx(
          relayerKeypair.publicKey,
          mintPk,
          destPk,
          amountLamports
        );

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
          if (s?.err) break;
          if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
            confirmed = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1200));
        }

        if (confirmed) {
          await db
            .update(mixWalletsTable)
            .set({ status: "available", amountLamports: amountLamports.toString() })
            .where(eq(mixWalletsTable.id, row.id));
          refilled.push(row.stokenAta);
          logger.info({ sig, stokenAta: row.stokenAta }, "mix/refill: decoy account refilled");
        } else {
          failed.push(row.stokenAta);
        }
      } catch (txErr) {
        logger.warn({ txErr, stokenAta: row.stokenAta }, "mix/refill: TX failed");
        failed.push(row.stokenAta);
      }

      if (depleted.indexOf(row) < depleted.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    res.json({ refilled: refilled.length, failed: failed.length, accounts: refilled });
  } catch (err) {
    req.log.error({ err }, "mix/refill error");
    res.status(500).json({ error: "Failed to refill mix pool" });
  }
});

// ─── POST /admin/mix/recover-stale ────────────────────────────────────────────
// Mark in_use accounts older than 5 minutes back to their prior status.
// Wallets with a secretKey were "ready" before reservation; restore to "ready".
// Wallets without a secretKey had sSOL minted; restore to "available".

router.post("/admin/mix/recover-stale", async (req, res): Promise<void> => {
  try {
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
    const stale = await db
      .select()
      .from(mixWalletsTable)
      .where(eq(mixWalletsTable.status, "in_use"));

    const toRecover = stale.filter(
      (r) => r.lastUsedAt && r.lastUsedAt < staleThreshold
    );

    for (const row of toRecover) {
      // Restore to "ready" if secret key is still present (was a pre-generated keypair).
      // Restore to "available" if no secret key (sSOL was already minted on-chain).
      const status = row.secretKey ? "ready" : "available";
      await db
        .update(mixWalletsTable)
        .set({ status })
        .where(eq(mixWalletsTable.id, row.id));
    }

    res.json({ recovered: toRecover.length });
  } catch (err) {
    req.log.error({ err }, "mix/recover-stale error");
    res.status(500).json({ error: "Failed to recover stale mix wallets" });
  }
});

// ─── POST /admin/mix/close-depleted ──────────────────────────────────────────
// Immediately trigger a close_decoy TX for up to 10 depleted accounts.
// Closes stoken_ata + user_state PDA on-chain. Rent returns to relayer.
// This runs automatically every 10 minutes via mix-pool-worker.
// This route allows manual triggering (admin only).

router.post("/admin/mix/close-depleted", async (req, res): Promise<void> => {
  if (!relayerKeypair) {
    res.status(503).json({ error: "Relayer not configured." });
    return;
  }
  try {
    const result = await runCloseDepletedDecoys();
    if (result.error && result.closed === 0) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "mix/close-depleted error");
    res.status(500).json({ error: "Failed to close depleted decoy accounts" });
  }
});

export default router;
