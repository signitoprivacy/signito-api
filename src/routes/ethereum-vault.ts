import { randomBytes } from "crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  ethereumMixWalletsTable,
  ethereumStealthPendingTable,
  ethereumVaultsTable,
} from "@workspace/db";
import {
  ETHEREUM_POOL_ABI,
  ETHEREUM_SHETH_ABI,
  ethereumPublicClient,
  getEthereumPoolAddress,
  getEthereumRelayerAddress,
  getEthereumShETHAddress,
  getEthereumWalletClient,
  isEthereumEnabled,
  waitForEthereumReceipt,
  withEthereumRpcRetry,
} from "../lib/ethereum-relayer.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();
const DECOY_COUNT = 20;
const provisioningByVault = new Map<string, Promise<void>>();
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

function randomAddress(): `0x${string}` {
  return `0x${randomBytes(20).toString("hex")}`;
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

async function spawnDecoys(stokenAddress: string, amount: bigint, count = DECOY_COUNT): Promise<void> {
  const decoys = Array.from({ length: count }, randomAddress);
  const { client, account } = getEthereumWalletClient();
  const hash = await client.writeContract({
    address: getEthereumPoolAddress(),
    abi: ETHEREUM_POOL_ABI,
    functionName: "batchAdminMint",
    args: [decoys, amount],
    account,
  });
  const receipt = await waitForEthereumReceipt(hash);
  if (receipt.status !== "success") throw new Error("Ethereum decoy mint reverted on-chain.");
  await db.insert(ethereumMixWalletsTable).values(
    decoys.map((address) => ({
      stokenAddress: address,
      balance: amount.toString(),
      status: "ready",
      linkedStokenAddress: stokenAddress,
      mintedAmount: amount.toString(),
    }))
  );
}

async function getUsableDecoys(stokenAddress: string, amount: bigint) {
  const rows = await db
    .select()
    .from(ethereumMixWalletsTable)
    .where(and(
      eq(ethereumMixWalletsTable.linkedStokenAddress, stokenAddress),
      eq(ethereumMixWalletsTable.status, "ready"),
    ));
  return rows.filter((row) => BigInt(row.mintedAmount) >= amount);
}

async function ensurePrivacySet(stokenAddress: string, amount: bigint): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ready = await getUsableDecoys(stokenAddress, amount);
    const missing = DECOY_COUNT - ready.length;
    if (missing <= 0) return;

    const existing = provisioningByVault.get(stokenAddress);
    if (existing) {
      await existing;
      continue;
    }
    const job = spawnDecoys(stokenAddress, amount, missing);
    provisioningByVault.set(stokenAddress, job);
    try {
      await job;
    } finally {
      provisioningByVault.delete(stokenAddress);
    }
  }
  throw new Error("Ethereum privacy-set preparation did not reach 20 funded decoys.");
}

router.get("/ethereum/status", async (_req, res): Promise<void> => {
  if (!isEthereumEnabled()) {
    res.status(503).json({ enabled: false, message: "Ethereum Mainnet is not deployed or configured" });
    return;
  }
  try {
    const [poolBalance, totalSupply] = await withEthereumRpcRetry(() => Promise.all([
      ethereumPublicClient.getBalance({ address: getEthereumPoolAddress() }),
      ethereumPublicClient.readContract({
        address: getEthereumShETHAddress(),
        abi: ETHEREUM_SHETH_ABI,
        functionName: "totalSupply",
      }),
    ]));
    res.json({
      enabled: true,
      available: true,
      poolAddress: getEthereumPoolAddress(),
      shethAddress: getEthereumShETHAddress(),
      relayerAddress: getEthereumRelayerAddress(),
      poolBalance: poolBalance.toString(),
      shethTotalSupply: totalSupply.toString(),
      network: "mainnet",
    });
  } catch (err) {
    _req.log.error({ err }, "ethereum/status error");
    res.status(503).json({
      enabled: true,
      available: false,
      error: "Ethereum RPC temporarily unavailable",
      retryable: true,
      network: "mainnet",
    });
  }
});

router.get("/ethereum/vault/state/:stokenAddress", async (req, res): Promise<void> => {
  const parsed = addressSchema.safeParse(req.params.stokenAddress);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid address" });
    return;
  }
  if (!isEthereumEnabled()) {
    res.status(503).json({ error: "Ethereum Mainnet is not configured" });
    return;
  }
  try {
    let state: readonly [string, number, bigint, boolean] | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      state = await withEthereumRpcRetry(() => ethereumPublicClient.readContract({
        address: getEthereumPoolAddress(),
        abi: ETHEREUM_POOL_ABI,
        functionName: "getUserState",
        args: [parsed.data as `0x${string}`],
      }));
      // A just-confirmed shield can be visible on one RPC before another.
      // Retry the valid-but-stale default state before returning it.
      if (state[3] || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (!state) throw new Error("Ethereum RPC returned no vault state");
    res.json({
      currentOtsHash: state[0],
      chainDepth: state[1],
      deposited: state[2].toString(),
      initialized: state[3],
    });
  } catch (err) {
    req.log.error({ err }, "ethereum vault state error");
    res.status(503).json({
      error: "Ethereum RPC temporarily unavailable",
      retryable: true,
    });
  }
});

router.post("/ethereum/vault/register", async (req, res): Promise<void> => {
  if (!isEthereumEnabled()) {
    res.status(503).json({ error: "Ethereum Mainnet is not configured" });
    return;
  }
  const schema = z.object({
    wallet: addressSchema,
    stokenAddress: addressSchema,
    chainDepth: z.number().int().min(1).max(64).default(32),
    generation: z.number().int().min(0).default(0),
    lastOtsHash: hashSchema.optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { wallet, stokenAddress, chainDepth, generation, lastOtsHash } = parsed.data;
  await db
    .insert(ethereumVaultsTable)
    .values({ wallet, stokenAddress, chainDepth, generation, lastOtsHash })
    .onConflictDoNothing();

  try {
    const amount = await withEthereumRpcRetry(() => ethereumPublicClient.readContract({
      address: getEthereumShETHAddress(),
      abi: ETHEREUM_SHETH_ABI,
      functionName: "balanceOf",
      args: [stokenAddress as `0x${string}`],
    }));
    if (amount <= 0n) throw new Error("Vault shield balance is not available on-chain.");
    await spawnDecoys(stokenAddress, amount);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err, stokenAddress }, "ethereum decoy registration failed");
    res.status(502).json({ error: "Ethereum vault registration could not mint decoys" });
  }
});

router.get("/ethereum/vault/vaults/:wallet", async (req, res): Promise<void> => {
  const parsed = addressSchema.safeParse(req.params.wallet);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid wallet address" });
    return;
  }
  const rows = await db
    .select()
    .from(ethereumVaultsTable)
    .where(eq(ethereumVaultsTable.wallet, parsed.data));
  res.json(rows);
});

router.get("/ethereum/vault/readiness/:stokenAddress", async (req, res): Promise<void> => {
  const parsed = addressSchema.safeParse(req.params.stokenAddress);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid address" });
    return;
  }
  const amount = typeof req.query.amount === "string" && /^\d+$/.test(req.query.amount)
    ? BigInt(req.query.amount)
    : 0n;
  const readyDecoys = (await getUsableDecoys(parsed.data, amount)).length;
  res.json({ ready: readyDecoys >= DECOY_COUNT, readyDecoys, requiredDecoys: DECOY_COUNT });
});

router.post("/ethereum/vault/unshield", async (req, res): Promise<void> => {
  if (!isEthereumEnabled()) {
    res.status(503).json({ error: "Ethereum Mainnet is not configured" });
    return;
  }
  const schema = z.object({
    stokenAddress: addressSchema,
    wallet: addressSchema,
    otsPreimage: hashSchema,
    amount: z.string().regex(/^\d+$/),
    recipient: addressSchema,
    action: z.enum(["unshield", "zk-send"]).default("unshield"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { stokenAddress, wallet, otsPreimage, amount, recipient, action } = parsed.data;
  const amountWei = BigInt(amount);
  let pendingId: number | undefined;
  let decoysLocked = false;
  let transactionBroadcast = false;
  let decoyIds: number[] = [];
  try {
    const [pending] = await db
      .insert(ethereumStealthPendingTable)
      .values({ wallet, stokenAddress, amount, recipient, action, status: "pending" })
      .returning();
    pendingId = pending.id;

    let usableDecoys = await getUsableDecoys(stokenAddress, amountWei);
    if (usableDecoys.length < DECOY_COUNT) {
      await db
        .update(ethereumStealthPendingTable)
        .set({ status: "provisioning", error: null })
        .where(eq(ethereumStealthPendingTable.id, pending.id));
      req.log.info(
        { stokenAddress, readyDecoys: usableDecoys.length, requiredDecoys: DECOY_COUNT, action },
        "preparing Ethereum privacy set",
      );
      await ensurePrivacySet(stokenAddress, amountWei);
      usableDecoys = await getUsableDecoys(stokenAddress, amountWei);
    }
    if (usableDecoys.length < DECOY_COUNT) {
      throw new Error("Ethereum privacy-set preparation did not reach 20 funded decoys.");
    }
    const selectedDecoys = usableDecoys.slice(0, DECOY_COUNT);
    const decoys = selectedDecoys.map((row) => row.stokenAddress as `0x${string}`);
    decoyIds = selectedDecoys.map((row) => row.id);
    await db
      .update(ethereumStealthPendingTable)
      .set({ status: "pending", error: null })
      .where(eq(ethereumStealthPendingTable.id, pending.id));

    await db
      .update(ethereumMixWalletsTable)
      .set({ status: "burning" })
      .where(and(
        inArray(ethereumMixWalletsTable.id, decoyIds),
        eq(ethereumMixWalletsTable.status, "ready"),
      ));
    decoysLocked = true;
    const { client, account } = getEthereumWalletClient();
    const burnHash = await client.writeContract({
      address: getEthereumPoolAddress(),
      abi: ETHEREUM_POOL_ABI,
      functionName: "burnAndQueue",
      args: [
        amountWei,
        otsPreimage as `0x${string}`,
        shuffle<`0x${string}`>([
          stokenAddress as `0x${string}`,
          wallet as `0x${string}`,
          ...decoys,
        ]),
      ],
      account,
    });
    transactionBroadcast = true;
    const burnReceipt = await waitForEthereumReceipt(burnHash);
    if (burnReceipt.status !== "success") {
      await db
        .update(ethereumStealthPendingTable)
        .set({ burnTxHash: burnHash, status: "failed", error: "Ethereum burn transaction reverted." })
        .where(eq(ethereumStealthPendingTable.id, pending.id));
      await db
        .update(ethereumMixWalletsTable)
        .set({ status: "ready" })
        .where(and(
          inArray(ethereumMixWalletsTable.id, decoyIds),
          eq(ethereumMixWalletsTable.status, "burning"),
        ));
      res.status(500).json({ error: "Ethereum burn transaction reverted." });
      return;
    }
    await db
      .update(ethereumStealthPendingTable)
      .set({ burnTxHash: burnHash, status: "burned" })
      .where(eq(ethereumStealthPendingTable.id, pending.id));
    await db
      .update(ethereumMixWalletsTable)
      .set({ status: "burned" })
        .where(and(
          inArray(ethereumMixWalletsTable.id, decoyIds),
          eq(ethereumMixWalletsTable.status, "burning"),
        ));

    const processHash = await client.writeContract({
      address: getEthereumPoolAddress(),
      abi: ETHEREUM_POOL_ABI,
      functionName: "processQueue",
      args: [recipient as `0x${string}`, amountWei],
      account,
    });
    transactionBroadcast = true;
    await db
      .update(ethereumStealthPendingTable)
      .set({ processTxHash: processHash, status: "processing" })
      .where(eq(ethereumStealthPendingTable.id, pending.id));
    const processReceipt = await waitForEthereumReceipt(processHash);
    if (processReceipt.status !== "success") {
      await db
        .update(ethereumStealthPendingTable)
        .set({ status: "failed", error: "Ethereum process transaction reverted." })
        .where(eq(ethereumStealthPendingTable.id, pending.id));
      res.status(500).json({ error: "Ethereum process transaction reverted." });
      return;
    }
    await db
      .update(ethereumStealthPendingTable)
      .set({ status: "processed" })
      .where(eq(ethereumStealthPendingTable.id, pending.id));
    res.json({ burnTxHash: burnHash, processTxHash: processHash, totalBurned: DECOY_COUNT + 2 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "ethereum unshield error");
    if (pendingId) {
      await db
        .update(ethereumStealthPendingTable)
        .set({
          status: transactionBroadcast ? "unknown" : "failed",
          error: message,
        })
        .where(eq(ethereumStealthPendingTable.id, pendingId));
    }
    if (!transactionBroadcast && decoysLocked) {
      await db
        .update(ethereumMixWalletsTable)
        .set({ status: "ready" })
        .where(and(
          inArray(ethereumMixWalletsTable.id, decoyIds),
          eq(ethereumMixWalletsTable.status, "burning")
        ));
    }
    res.status(500).json({ error: message });
    return;
  }
});

router.get("/ethereum/vault/history/:wallet", async (req, res): Promise<void> => {
  const parsed = addressSchema.safeParse(req.params.wallet);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid wallet address" });
    return;
  }
  const rows = await db
    .select()
    .from(ethereumStealthPendingTable)
    .where(eq(ethereumStealthPendingTable.wallet, parsed.data))
    .orderBy(desc(ethereumStealthPendingTable.createdAt));
  res.json(rows);
});

router.post("/ethereum/vault/refresh-ots", async (req, res): Promise<void> => {
  if (!isEthereumEnabled()) {
    res.status(503).json({ error: "Ethereum Mainnet is not configured" });
    return;
  }
  const schema = z.object({
    stokenAddress: addressSchema,
    otsPreimage: hashSchema,
    newOtsHash: hashSchema,
    newChainDepth: z.number().int().min(1).max(64).default(32),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const { client, account } = getEthereumWalletClient();
    const hash = await client.writeContract({
      address: getEthereumPoolAddress(),
      abi: ETHEREUM_POOL_ABI,
      functionName: "refreshOts",
      args: [
        parsed.data.stokenAddress as `0x${string}`,
        parsed.data.otsPreimage as `0x${string}`,
        parsed.data.newOtsHash as `0x${string}`,
        parsed.data.newChainDepth,
      ],
      account,
    });
    const receipt = await waitForEthereumReceipt(hash);
    if (receipt.status !== "success") throw new Error("Ethereum OTS refresh reverted.");
    res.json({ ok: true, txHash: hash });
  } catch (err) {
    req.log.error({ err }, "ethereum refresh-ots error");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function recoverStuckTransactions(): Promise<void> {
  if (!isEthereumEnabled()) return;
  try {
    const stuck = await db
      .select()
      .from(ethereumStealthPendingTable)
      .where(
        and(
          eq(ethereumStealthPendingTable.status, "burned"),
          isNull(ethereumStealthPendingTable.processTxHash)
        )
      );
    for (const pending of stuck) {
      try {
        await db
          .update(ethereumStealthPendingTable)
          .set({ status: "recovering" })
          .where(eq(ethereumStealthPendingTable.id, pending.id));
        const { client, account } = getEthereumWalletClient();
        const hash = await client.writeContract({
          address: getEthereumPoolAddress(),
          abi: ETHEREUM_POOL_ABI,
          functionName: "processQueue",
          args: [pending.recipient as `0x${string}`, BigInt(pending.amount)],
          account,
        });
        const receipt = await waitForEthereumReceipt(hash);
        if (receipt.status !== "success") throw new Error("Ethereum recovery process reverted.");
        await db
          .update(ethereumStealthPendingTable)
          .set({ processTxHash: hash, status: "processed" })
          .where(eq(ethereumStealthPendingTable.id, pending.id));
      } catch (err) {
        logger.error({ err, id: pending.id }, "ethereum recovery failed");
        await db
          .update(ethereumStealthPendingTable)
          .set({ status: "recovery_failed" })
          .where(eq(ethereumStealthPendingTable.id, pending.id));
      }
    }
  } catch (err) {
    logger.error({ err }, "ethereum recovery query failed");
  }
}

setTimeout(() => {
  void recoverStuckTransactions();
}, 8_000);

export default router;