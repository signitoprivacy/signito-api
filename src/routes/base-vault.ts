import { Router } from "express";
import { z } from "zod";
import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db, baseVaultsTable, baseStealthPendingTable, baseMixWalletsTable } from "@workspace/db";
import {
  isBaseEnabled,
  getBaseWalletClient,
  getPoolAddress,
  getShETHAddress,
  getRelayerAddress,
  basePublicClient,
  waitForBaseReceipt,
  withBaseRpcRetry,
  POOL_ABI,
  SHETH_ABI,
} from "../lib/base-relayer.js";
import { logger } from "../lib/logger.js";

const router = Router();

const DECOY_COUNT = 20;
const provisioningByVault = new Map<string, Promise<void>>();

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
  log: (msg: string, data?: object) => void,
  count = DECOY_COUNT,
): Promise<void> {
  const fakeAddresses: `0x${string}`[] = Array.from({ length: count }, randomAddress);
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
      log("batchAdminMint submitted", { mintHash, linkedStokenAddress, count, attempt });

      await waitForBaseReceipt(mintHash);
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

  throw new Error("Base privacy-set preparation failed after three relayer attempts.");
}

async function getUsableDecoys(linkedStokenAddress: string, amount: bigint) {
  const rows = await db
    .select()
    .from(baseMixWalletsTable)
    .where(and(
      eq(baseMixWalletsTable.linkedStokenAddress, linkedStokenAddress),
      eq(baseMixWalletsTable.status, "ready"),
    ));
  return rows.filter((row) => BigInt(row.mintedAmount) >= amount);
}

async function ensurePrivacySet(
  linkedStokenAddress: string,
  amount: bigint,
  log: (message: string, data?: object) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ready = await getUsableDecoys(linkedStokenAddress, amount);
    const missing = DECOY_COUNT - ready.length;
    if (missing <= 0) return;

    const existing = provisioningByVault.get(linkedStokenAddress);
    if (existing) {
      await existing;
      continue;
    }

    const job = spawnDecoys(linkedStokenAddress, amount, log, missing);
    provisioningByVault.set(linkedStokenAddress, job);
    try {
      await job;
    } finally {
      provisioningByVault.delete(linkedStokenAddress);
    }
  }

  throw new Error("Base privacy-set preparation did not reach 20 funded decoys.");
}

// GET /base/status
router.get("/base/status", async (req, res) => {
  if (!isBaseEnabled()) {
    return res.status(503).json({ enabled: false, message: "Base chain not configured" });
  }
  try {
    const poolAddress = getPoolAddress();
    const [poolBalance, totalSupply] = await withBaseRpcRetry(() => Promise.all([
      basePublicClient.getBalance({ address: poolAddress }),
      basePublicClient.readContract({
        address: getShETHAddress(),
        abi: SHETH_ABI,
        functionName: "totalSupply",
      }),
    ]));
    return res.json({
      enabled: true,
      available: true,
      poolAddress,
      sethAddress: getShETHAddress(),
      relayerAddress: getRelayerAddress(),
      poolBalance: poolBalance.toString(),
      sethTotalSupply: totalSupply.toString(),
      network: process.env.BASE_NETWORK ?? "sepolia",
    });
  } catch (err) {
    req.log.error({ err }, "base/status error");
    return res.status(503).json({
      enabled: true,
      available: false,
      error: "Base RPC temporarily unavailable",
      retryable: true,
      network: process.env.BASE_NETWORK ?? "sepolia",
    });
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
    let result: readonly [string, number, bigint, boolean] | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await withBaseRpcRetry(() => basePublicClient.readContract({
        address: getPoolAddress(),
        abi: POOL_ABI,
        functionName: "getUserState",
        args: [stokenAddress as `0x${string}`],
      }));
      // A just-confirmed shield can be visible on one RPC before another.
      // Retry the valid-but-stale default state before returning it.
      if (result[3] || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (!result) {
      throw new Error("Base RPC returned no vault state");
    }
    return res.json({
      currentOtsHash: result[0],
      chainDepth: result[1],
      deposited: result[2].toString(),
      initialized: result[3],
    });
  } catch (err) {
    req.log.error({ err }, "getUserState error");
    return res.status(503).json({
      error: "Base RPC temporarily unavailable",
      retryable: true,
    });
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

// Readiness is intentionally limited to anonymous capacity information. It never
// exposes decoy addresses or relayer credentials.
router.get("/base/vault/readiness/:stokenAddress", async (req, res): Promise<void> => {
  const { stokenAddress } = req.params;
  const amount = typeof req.query.amount === "string" && /^\d+$/.test(req.query.amount)
    ? BigInt(req.query.amount)
    : 0n;
  if (!/^0x[0-9a-fA-F]{40}$/.test(stokenAddress)) {
    res.status(400).json({ error: "invalid address" });
    return;
  }
  const readyDecoys = (await getUsableDecoys(stokenAddress, amount)).length;
  res.json({ ready: readyDecoys >= DECOY_COUNT, readyDecoys, requiredDecoys: DECOY_COUNT });
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
    action: z.enum(["unshield", "zk-send"]).default("unshield"),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { stokenAddress, wallet, otsPreimage, amount, recipient, action } = parsed.data;
  const amountBig = BigInt(amount);
  const stokenAddr = stokenAddress as `0x${string}`;
  const recipientAddr = recipient as `0x${string}`;
  const preimageHex = otsPreimage as `0x${string}`;
  let pendingId: number | undefined;
  let decoysLocked = false;
  let transactionBroadcast = false;
  let decoyIds: number[] = [];

  try {
    const { client, account } = getBaseWalletClient();
    const poolAddress = getPoolAddress();

    const [pending] = await db
      .insert(baseStealthPendingTable)
      .values({ wallet, stokenAddress, amount, recipient, action, status: "pending" })
      .returning();
    pendingId = pending.id;

    let usableDecoys = await getUsableDecoys(stokenAddress, amountBig);
    if (usableDecoys.length < DECOY_COUNT) {
      await db
        .update(baseStealthPendingTable)
        .set({ status: "provisioning", error: null })
        .where(eq(baseStealthPendingTable.id, pending.id));
      req.log.info(
        { stokenAddress, readyDecoys: usableDecoys.length, requiredDecoys: DECOY_COUNT, action },
        "preparing Base privacy set",
      );
      await ensurePrivacySet(stokenAddress, amountBig, (message, data) => req.log.info(data ?? {}, message));
      usableDecoys = await getUsableDecoys(stokenAddress, amountBig);
    }
    if (usableDecoys.length < DECOY_COUNT) {
      throw new Error("Base privacy-set preparation did not reach 20 funded decoys.");
    }

    const selectedDecoys = usableDecoys.slice(0, DECOY_COUNT);
    const decoyAddresses = selectedDecoys.map((d) => d.stokenAddress as `0x${string}`);
    decoyIds = selectedDecoys.map((d) => d.id);
    await db
      .update(baseStealthPendingTable)
      .set({ status: "pending", error: null })
      .where(eq(baseStealthPendingTable.id, pending.id));

    req.log.info(
      { stokenAddress, decoyCount: decoyAddresses.length },
      "burnAndQueue starting"
    );

    // Mark decoys as burning before TX to prevent double-use.
    if (decoyIds.length > 0) {
      await db
        .update(baseMixWalletsTable)
        .set({ status: "burning" })
        .where(and(
          inArray(baseMixWalletsTable.id, decoyIds),
          eq(baseMixWalletsTable.status, "ready"),
        ));
      decoysLocked = true;
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
    transactionBroadcast = true;
    req.log.info({ burnHash, totalAccounts: allBurnAccounts.length }, "burnAndQueue submitted");

    await db
      .update(baseStealthPendingTable)
      .set({ burnTxHash: burnHash, status: "burned" })
      .where(eq(baseStealthPendingTable.id, pending.id));

    const receipt1 = await waitForBaseReceipt(burnHash);

    if (receipt1.status !== "success") {
      // Restore decoys to ready if burn failed so they can be retried.
      if (decoyIds.length > 0) {
        await db
          .update(baseMixWalletsTable)
          .set({ status: "ready" })
          .where(and(
            inArray(baseMixWalletsTable.id, decoyIds),
            eq(baseMixWalletsTable.status, "burning"),
          ));
      }
      await db
        .update(baseStealthPendingTable)
        .set({ status: "failed" })
        .where(eq(baseStealthPendingTable.id, pending.id));
      return res.status(500).json({ error: "burnAndQueue reverted on-chain" });
    }

    // Mark decoys as burned after confirmed TX.
    if (decoyIds.length > 0) {
      await db
        .update(baseMixWalletsTable)
        .set({ status: "burned" })
        .where(and(
          inArray(baseMixWalletsTable.id, decoyIds),
          eq(baseMixWalletsTable.status, "burning"),
        ));
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
    transactionBroadcast = true;
    req.log.info({ processHash }, "processQueue submitted");

    await db
      .update(baseStealthPendingTable)
      .set({ processTxHash: processHash, status: "processing" })
      .where(eq(baseStealthPendingTable.id, pending.id));

    const processReceipt = await waitForBaseReceipt(processHash);
    if (processReceipt.status !== "success") {
      await db
        .update(baseStealthPendingTable)
        .set({ status: "failed", error: "processQueue reverted on-chain" })
        .where(eq(baseStealthPendingTable.id, pending.id));
      return res.status(500).json({ error: "processQueue reverted on-chain" });
    }
    await db
      .update(baseStealthPendingTable)
      .set({ status: "processed" })
      .where(eq(baseStealthPendingTable.id, pending.id));

    return res.json({
      burnTxHash: burnHash,
      processTxHash: processHash,
      totalBurned: allBurnAccounts.length,
    });
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    req.log.error({ err }, "unshield error");
    if (pendingId) {
      await db
        .update(baseStealthPendingTable)
        .set({
          status: transactionBroadcast ? "unknown" : "failed",
          error: message,
        })
        .where(eq(baseStealthPendingTable.id, pendingId));
    }
    // Never release decoys after any transaction hash was returned. A receipt
    // timeout is unknown state, not a safe retry condition.
    if (!transactionBroadcast && decoysLocked) {
      await db
        .update(baseMixWalletsTable)
        .set({ status: "ready" })
        .where(and(
          inArray(baseMixWalletsTable.id, decoyIds),
          eq(baseMixWalletsTable.status, "burning"),
        ));
    }
    res.status(500).json({ error: message });
    return;
  }
});

// GET /base/vault/history/:wallet
router.get("/base/vault/history/:wallet", async (req, res) => {
  const { wallet } = req.params;
  const rows = await db
    .select()
    .from(baseStealthPendingTable)
    .where(eq(baseStealthPendingTable.wallet, wallet))
    .orderBy(desc(baseStealthPendingTable.createdAt));
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
    await waitForBaseReceipt(hash);
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
        await waitForBaseReceipt(processHash);

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
