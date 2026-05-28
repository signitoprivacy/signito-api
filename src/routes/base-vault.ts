import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
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

const router = Router();

const DECOY_COUNT = 20;

// Generate a random Ethereum-style address (hex, not a real wallet -- used for decoy stokenAddresses).
function randomAddress(): `0x${string}` {
  return `0x${randomBytes(20).toString("hex")}`;
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
    log("batchAdminMint submitted", { mintHash, linkedStokenAddress, count: DECOY_COUNT });

    await basePublicClient.waitForTransactionReceipt({ hash: mintHash, timeout: 60_000 });
    log("batchAdminMint confirmed", { mintHash });

    // Store all 20 decoys in DB, linked to the real stokenAddress.
    await db.insert(baseMixWalletsTable).values(
      fakeAddresses.map((addr) => ({
        stokenAddress: addr,
        balance: amount.toString(),
        status: "ready",
        linkedStokenAddress,
        mintedAmount: amount.toString(),
      }))
    ).onConflictDoNothing();
  } catch (err) {
    // Decoy minting failure is non-fatal: privacy is reduced but the shield still succeeds.
    log("batchAdminMint failed (non-fatal)", { err: String(err), linkedStokenAddress });
  }
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
// Called after the user's shield() TX confirms on-chain.
// Stores the stokenAddress, then spawns 20 phantom decoy accounts via batchAdminMint.
// Decoys are minted for the same amount as the real shield, so all 21 burns match on unshield.
router.post("/base/vault/register", async (req, res) => {
  const schema = z.object({
    wallet: z.string().min(1),
    stokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    chainDepth: z.number().int().min(1).max(64).default(32),
    generation: z.number().int().min(0).default(0),
    lastOtsHash: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { wallet, stokenAddress, chainDepth, generation, lastOtsHash } = parsed.data;

  await db
    .insert(baseVaultsTable)
    .values({ wallet, stokenAddress, chainDepth, generation, lastOtsHash })
    .onConflictDoNothing();

  // Spawn decoys in the background -- non-blocking so register returns immediately.
  // Read the on-chain shielded amount from the sETH balance to know how much to adminMint.
  if (isBaseEnabled()) {
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
    wallet: z.string().min(1),
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
    // allBurnAccounts = decoy addresses (real stokenAddress is burned separately by the contract).
    // Submitted via Flashbots on mainnet, public RPC on testnet.
    const burnHash = await client.writeContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "burnAndQueue",
      args: [stokenAddr, amountBig, preimageHex, decoyAddresses],
      account,
    });
    req.log.info({ burnHash, decoyCount: decoyAddresses.length }, "burnAndQueue submitted");

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
      decoyCount: decoyAddresses.length,
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

export default router;
