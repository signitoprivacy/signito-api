import { Router } from "express";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db, baseVaultsTable, baseStealthPendingTable, baseMixWalletsTable } from "@workspace/db";
import {
  isBaseEnabled,
  getBaseWalletClient,
  getPoolAddress,
  getShETHAddress,
  getRelayerAddress,
  basePublicClient,
  POOL_ABI,
  SHETH_ABI,
} from "../lib/base-relayer.js";
import { logger } from "../lib/logger.js";

const router = Router();

const DECOY_COUNT = 20;

// Generate a random Ethereum-style address (hex, not a real wallet -- used for decoy addresses).
function randomAddress(): `0x${string}` {
  return `0x${randomBytes(20).toString("hex")}`;
}

// Fisher-Yates shuffle -- randomizes position of real stokenAddress among decoys.
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Spawn 20 phantom sETH accounts for the given real stokenAddress.
// Called once immediately after a real shield registers.
// Uses batchAdminMint: single TX, gas only, no ETH cost.
async function spawnDecoys(
  linkedStokenAddress: string,
  amount: bigint,
  log: (msg: string, data?: object) => void
): Promise<void> {
  const fakeAddresses: `0x${string}`[] = Array.from({ length: DECOY_COUNT }, randomAddress);
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { client, account } = getBaseWalletClient();
      const poolAddress = getPoolAddress();

      const mintHash = await client.writeContract({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: "batchAdminMint",
        args: [fakeAddresses, amount],
        account,
      });
      log("batchAdminMint submitted", { mintHash, linkedStokenAddress, count: DECOY_COUNT, attempt });

      await basePublicClient.waitForTransactionReceipt({ hash: mintHash, timeout: 60_000 });
      log("batchAdminMint confirmed", { mintHash, attempt });

      await db.insert(baseMixWalletsTable).values(
        fakeAddresses.map((addr) => ({
          stokenAddress: addr,
          balance: amount.toString(),
          status: "ready",
          linkedStokenAddress,
          mintedAmount: amount.toString(),
        }))
      ).onConflictDoNothing();

      return;
    } catch (err) {
      log(`batchAdminMint attempt ${attempt} failed`, { err: String(err), linkedStokenAddress });
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  log("batchAdminMint failed after all attempts (non-fatal, reduced anonymity set)", { linkedStokenAddress });
}

// GET /base/status
router.get("/base/status", async (req, res) => {
  if (!isBaseEnabled()) {
    return res.status(503).json({ enabled: false, message: "Base chain not configured" });
  }
  try {
    const poolAddress = getPoolAddress();
    const [poolBalance, totalSupply] = await Promise.all([
      basePublicClient.getBalance({ address: poolAddress }),
      basePublicClient.readContract({
        address: getShETHAddress(),
        abi: SHETH_ABI,
        functionName: "totalSupply",
      }),
    ]);
    return res.json({
      enabled: true,
      poolAddress,
      sethAddress: getShETHAddress(),
      relayerAddress: getRelayerAddress(),
      poolBalance: poolBalance.toString(),
      sethTotalSupply: totalSupply.toString(),
      network: process.env.BASE_NETWORK ?? "sepolia",
    });
  } catch (err) {
    req.log.error({ err }, "base/status error");
    return res.status(500).json({ error: "rpc error" });
  }
});

// GET /base/vault/state/:stokenAddress
// On-chain UserState: currentOtsHash, chainDepth, deposited, initialized
router.get("/base/vault/state/:stokenAddress", async (req, res) => {
  if (!isBaseEnabled()) return res.status(503).json({ error: "Base not configured" });
  const { stokenAddress } = req.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(stokenAddress)) {
    return res.status(400).json({ error: "invalid address" });
  }
  try {
    const result = await basePublicClient.readContract({
      address: getPoolAddress(),
      abi: POOL_ABI,
      functionName: "getUserState",
      args: [stokenAddress as `0x${string}`],
    });
    return res.json({
      currentOtsHash: result[0],
      chainDepth: result[1],
      deposited: result[2].toString(),
      initialized: result[3],
    });
  } catch (err) {
    req.log.error({ err }, "getUserState error");
    return res.status(500).json({ error: "rpc error" });
  }
});

// POST /base/vault/register
// Called after the user's shield TX confirms on-chain.
// Two modes:
//   shieldWithDecoys (new): client passes decoyAddresses already minted on-chain.
//     Server saves them to DB -- no batchAdminMint TX needed.
//   shield (legacy): no decoyAddresses provided.
//     Server generates 20 random decoys and calls batchAdminMint.
router.post("/base/vault/register", async (req, res) => {
  const schema = z.object({
    wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    stokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    chainDepth: z.number().int().min(1).max(64).default(32),
    generation: z.number().int().min(0).default(0),
    lastOtsHash: z.string().optional(),
    // Present when shieldWithDecoys was used -- decoys already on-chain, just save to DB.
    decoyAddresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(50).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { wallet, stokenAddress, chainDepth, generation, lastOtsHash, decoyAddresses } = parsed.data;

  await db
    .insert(baseVaultsTable)
    .values({ wallet, stokenAddress, chainDepth, generation, lastOtsHash })
    .onConflictDoNothing();

  if (decoyAddresses && decoyAddresses.length > 0) {
    // shieldWithDecoys path: decoys already minted on-chain in the shield TX.
    // Just persist them to DB so unshield can find them.
    (async () => {
      try {
        const balance = await basePublicClient.readContract({
          address: getShETHAddress(),
          abi: SHETH_ABI,
          functionName: "balanceOf",
          args: [stokenAddress as `0x${string}`],
        });
        const amount = balance > 0n ? balance : 1n;
        await db.insert(baseMixWalletsTable).values(
          decoyAddresses.map((addr) => ({
            stokenAddress: addr,
            balance: amount.toString(),
            status: "ready",
            linkedStokenAddress: stokenAddress,
            mintedAmount: amount.toString(),
          }))
        ).onConflictDoNothing();
        req.log.info({ stokenAddress, count: decoyAddresses.length }, "decoy addresses saved from shieldWithDecoys");
      } catch (err) {
        req.log.warn({ err, stokenAddress }, "decoy DB save skipped");
      }
    })();
  } else if (isBaseEnabled()) {
    // Legacy shield() path: generate random decoys and call batchAdminMint on-chain.
    (async () => {
      try {
        const balance = await basePublicClient.readContract({
          address: getShETHAddress(),
          abi: SHETH_ABI,
          functionName: "balanceOf",
          args: [stokenAddress as `0x${string}`],
        });
        if (balance > 0n) {
          await spawnDecoys(stokenAddress, balance, (msg, data) => {
            if (data) {
              req.log.info(data, msg);
            } else {
              req.log.info(msg);
            }
          });
        }
      } catch (err) {
        req.log.warn({ err, stokenAddress }, "decoy spawn skipped -- balance check failed");
      }
    })();
  }

  return res.json({ ok: true });
});

// GET /base/vault/vaults/:wallet
// List all registered stokenAddresses for a wallet.
router.get("/base/vault/vaults/:wallet", async (req, res) => {
  const { wallet } = req.params;
  const rows = await db
    .select()
    .from(baseVaultsTable)
    .where(eq(baseVaultsTable.wallet, wallet));
  return res.json(rows);
});

// POST /base/vault/unshield
// User sends OTS preimage + recipient off-chain. Relayer calls burnAndQueue (all 21 accounts) then processQueue.
// OTS preimage never appears in public mempool -- all TXs submitted via Flashbots on mainnet.
router.post("/base/vault/unshield", async (req, res) => {
  if (!isBaseEnabled()) return res.status(503).json({ error: "Base not configured" });

  const schema = z.object({
    stokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    otsPreimage: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    amount: z.string().regex(/^\d+$/),
    recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { stokenAddress, wallet, otsPreimage, amount, recipient } = parsed.data;
  const amountBig = BigInt(amount);
  const stokenAddr = stokenAddress as `0x${string}`;
  const recipientAddr = recipient as `0x${string}`;
  const preimageHex = otsPreimage as `0x${string}`;

  const [pending] = await db
    .insert(baseStealthPendingTable)
    .values({ wallet, stokenAddress, amount, recipient, status: "pending" })
    .returning();

  try {
    const { client, account } = getBaseWalletClient();
    const poolAddress = getPoolAddress();

    // Fetch the 20 decoys linked to this stokenAddress that are still ready to burn.
    const decoyRows = await db
      .select()
      .from(baseMixWalletsTable)
      .where(
        and(
          eq(baseMixWalletsTable.linkedStokenAddress, stokenAddress),
          eq(baseMixWalletsTable.status, "ready")
        )
      );

    // Filter to decoys that have enough balance to cover this burn amount.
    const usableDecoys = decoyRows.filter(
      (d) => BigInt(d.mintedAmount) >= amountBig
    );

    const decoyAddresses = usableDecoys.map((d) => d.stokenAddress as `0x${string}`);

    req.log.info(
      { stokenAddress, decoyCount: decoyAddresses.length },
      "burnAndQueue starting"
    );

    // Mark decoys as burning before TX to prevent double-use.
    if (decoyAddresses.length > 0) {
      await db
        .update(baseMixWalletsTable)
        .set({ status: "burning" })
        .where(
          and(
            eq(baseMixWalletsTable.linkedStokenAddress, stokenAddress),
            eq(baseMixWalletsTable.status, "ready")
          )
        );
    }

    // TX1: burnAndQueue
    // allBurnAccounts: stokenAddress + user wallet + 20 decoys = 22 addresses, shuffled to random order.
    // No explicit stokenAddress param -- contract finds it via OTS match inside the loop.
    // Submitted via Flashbots on mainnet, public RPC on testnet.
    const walletAddr = parsed.data.wallet as `0x${string}`;
    const allBurnAccounts = shuffleArray<`0x${string}`>([
      stokenAddr,
      walletAddr,
      ...decoyAddresses,
    ]);
    const burnHash = await client.writeContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "burnAndQueue",
      args: [amountBig, preimageHex, allBurnAccounts],
      account,
    });
    req.log.info({ burnHash, totalAccounts: allBurnAccounts.length }, "burnAndQueue submitted");

    await db
      .update(baseStealthPendingTable)
      .set({ burnTxHash: burnHash, status: "burned" })
      .where(eq(baseStealthPendingTable.id, pending.id));

    const receipt1 = await basePublicClient.waitForTransactionReceipt({
      hash: burnHash,
      timeout: 60_000,
    });

    if (receipt1.status !== "success") {
      // Restore decoys to ready if burn failed so they can be retried.
      if (decoyAddresses.length > 0) {
        await db
          .update(baseMixWalletsTable)
          .set({ status: "ready" })
          .where(
            and(
              eq(baseMixWalletsTable.linkedStokenAddress, stokenAddress),
              eq(baseMixWalletsTable.status, "burning")
            )
          );
      }
      await db
        .update(baseStealthPendingTable)
        .set({ status: "failed" })
        .where(eq(baseStealthPendingTable.id, pending.id));
      return res.status(500).json({ error: "burnAndQueue reverted on-chain" });
    }

    // Mark decoys as burned after confirmed TX.
    if (decoyAddresses.length > 0) {
      await db
        .update(baseMixWalletsTable)
        .set({ status: "burned" })
        .where(
          and(
            eq(baseMixWalletsTable.linkedStokenAddress, stokenAddress),
            eq(baseMixWalletsTable.status, "burning")
          )
        );
    }

    // TX2: processQueue -- separate TX, zero accounts in common with TX1.
    // On mainnet, relayer waits a random 5-30s before submitting to break timing correlation.
    if (process.env.BASE_NETWORK === "mainnet") {
      const delay = 5000 + Math.floor(Math.random() * 25000);
      await new Promise((r) => setTimeout(r, delay));
    }

    const processHash = await client.writeContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "processQueue",
      args: [recipientAddr, amountBig],
      account,
    });
    req.log.info({ processHash }, "processQueue submitted");

    await db
      .update(baseStealthPendingTable)
      .set({ processTxHash: processHash, status: "processed" })
      .where(eq(baseStealthPendingTable.id, pending.id));

    await basePublicClient.waitForTransactionReceipt({
      hash: processHash,
      timeout: 60_000,
    });

    return res.json({
      burnTxHash: burnHash,
      processTxHash: processHash,
      totalBurned: allBurnAccounts.length,
    });
  } catch (err) {
    req.log.error({ err }, "unshield error");
    await db
      .update(baseStealthPendingTable)
      .set({ status: "failed" })
      .where(eq(baseStealthPendingTable.id, pending.id));
    return res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// GET /base/vault/history/:wallet
router.get("/base/vault/history/:wallet", async (req, res) => {
  const { wallet } = req.params;
  const rows = await db
    .select()
    .from(baseStealthPendingTable)
    .where(eq(baseStealthPendingTable.wallet, wallet))
    .orderBy(baseStealthPendingTable.createdAt);
  return res.json(rows);
});

// POST /base/vault/refresh-ots
// Rotate the OTS chain for an existing vault without changing vault address.
// Consumes one OTS step from the current chain, then sets a new tip.
router.post("/base/vault/refresh-ots", async (req, res) => {
  if (!isBaseEnabled()) return res.status(503).json({ error: "Base not configured" });

  const schema = z.object({
    stokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    otsPreimage: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    newOtsHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    newChainDepth: z.number().int().min(1).max(64).default(32),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { stokenAddress, otsPreimage, newOtsHash, newChainDepth } = parsed.data;

  try {
    const { client, account } = getBaseWalletClient();
    const poolAddress = getPoolAddress();

    const hash = await client.writeContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "refreshOts",
      args: [
        stokenAddress as `0x${string}`,
        otsPreimage as `0x${string}`,
        newOtsHash as `0x${string}`,
        newChainDepth,
      ],
      account,
    });

    req.log.info({ hash, stokenAddress }, "refreshOts submitted");
    await basePublicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    req.log.info({ hash, stokenAddress }, "refreshOts confirmed");

    return res.json({ ok: true, txHash: hash });
  } catch (err) {
    req.log.error({ err }, "refresh-ots error");
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Startup recovery: re-process stuck "burned" transactions ─────────────────
// If the server crashed between burnAndQueue (TX1 confirmed) and processQueue (TX2 not
// submitted), the row stays status="burned" with processTxHash=null. ETH sits in pool,
// user never received funds. This worker detects and re-submits processQueue at startup.

async function recoverStuckTransactions(): Promise<void> {
  if (!isBaseEnabled()) return;
  try {
    const stuck = await db
      .select()
      .from(baseStealthPendingTable)
      .where(
        and(
          eq(baseStealthPendingTable.status, "burned"),
          isNull(baseStealthPendingTable.processTxHash)
        )
      );

    if (stuck.length === 0) return;

    logger.warn({ count: stuck.length }, "recovery: found stuck burned transactions, re-processing");

    for (const row of stuck) {
      try {
        // Mark as "recovering" first -- prevents a second recovery run from picking it up.
        await db
          .update(baseStealthPendingTable)
          .set({ status: "recovering" })
          .where(eq(baseStealthPendingTable.id, row.id));

        const { client, account } = getBaseWalletClient();
        const poolAddress = getPoolAddress();

        const processHash = await client.writeContract({
          address: poolAddress,
          abi: POOL_ABI,
          functionName: "processQueue",
          args: [row.recipient as `0x${string}`, BigInt(row.amount)],
          account,
        });

        logger.info({ processHash, id: row.id, recipient: row.recipient }, "recovery: processQueue submitted");
        await basePublicClient.waitForTransactionReceipt({ hash: processHash, timeout: 60_000 });

        await db
          .update(baseStealthPendingTable)
          .set({ processTxHash: processHash, status: "processed" })
          .where(eq(baseStealthPendingTable.id, row.id));

        logger.info({ processHash, id: row.id }, "recovery: processQueue confirmed, funds delivered");
      } catch (err) {
        logger.error({ err, id: row.id }, "recovery: processQueue failed, marking as recovery_failed");
        await db
          .update(baseStealthPendingTable)
          .set({ status: "recovery_failed" })
          .where(eq(baseStealthPendingTable.id, row.id))
          .catch(() => {});
      }
    }
  } catch (err) {
    logger.error({ err }, "recovery: failed to query stuck transactions");
  }
}

// Run once 8 seconds after module load -- gives the server time to fully start.
setTimeout(() => { void recoverStuckTransactions(); }, 8_000);

export default router;
