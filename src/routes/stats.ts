import { Router, type IRouter } from "express";
import { db, vaultsTable, transactionsTable, baseVaultsTable } from "@workspace/db";
import { count, sql, inArray } from "drizzle-orm";
import { getSolPriceUsd } from "../lib/sol-price.js";

const router: IRouter = Router();

router.get("/stats", async (req, res): Promise<void> => {
  try {
    // Count all Solana vaults (all mints: current + all historical program deploys)
    const [solanaVaultRow] = await db.select({ value: count() }).from(vaultsTable);
    const solanaVaults = solanaVaultRow?.value ?? 0;

    // Count all Base chain vaults
    const [baseVaultRow] = await db.select({ value: count() }).from(baseVaultsTable);
    const baseVaults = baseVaultRow?.value ?? 0;

    const totalVaults = solanaVaults + baseVaults;

    // Count all shield transactions
    const [shieldCountRow] = await db
      .select({ value: count() })
      .from(transactionsTable)
      .where(inArray(transactionsTable.type, ["shield"]));
    const totalTransactions = shieldCountRow?.value ?? 0;

    // Count all unshield + zk-transfer transactions
    const [unshieldCountRow] = await db
      .select({ value: count() })
      .from(transactionsTable)
      .where(inArray(transactionsTable.type, ["unshield", "zk-transfer"]));
    const transactionsUnshielded = unshieldCountRow?.value ?? 0;

    // Total shield volume in SOL (for backward compat)
    const [solRow] = await db
      .select({
        value: sql<string>`coalesce(sum(${transactionsTable.amount}::numeric) filter (where ${transactionsTable.type} = 'shield'), 0)`,
      })
      .from(transactionsTable);
    const totalVaultValue = Number(solRow?.value ?? 0);

    // Total shield volume in USD:
    // Use stored usd_value where available (captured at shield time),
    // fall back to current live SOL price for older records without a stored USD value.
    const [usdRow] = await db
      .select({
        storedUsd: sql<string>`coalesce(sum(${transactionsTable.usdValue}::numeric) filter (where ${transactionsTable.type} = 'shield' and ${transactionsTable.usdValue} is not null), 0)`,
        unpricedSol: sql<string>`coalesce(sum(${transactionsTable.amount}::numeric) filter (where ${transactionsTable.type} = 'shield' and ${transactionsTable.usdValue} is null), 0)`,
      })
      .from(transactionsTable);

    const storedUsd = Number(usdRow?.storedUsd ?? 0);
    const unpricedSol = Number(usdRow?.unpricedSol ?? 0);

    let solPrice = 0;
    if (unpricedSol > 0 || totalVaultValue > 0) {
      solPrice = (await getSolPriceUsd()) ?? 0;
    }

    const totalVaultValueUsd = storedUsd + unpricedSol * solPrice;

    // Protocol revenue: 0.15% fee on every unshield and zk-transfer
    const [revenueRow] = await db
      .select({
        value: sql<string>`coalesce(sum(${transactionsTable.amount}::numeric * 0.0015), 0)`,
      })
      .from(transactionsTable)
      .where(inArray(transactionsTable.type, ["unshield", "zk-transfer"]));

    const protocolRevenue = Number(revenueRow?.value ?? 0);
    const protocolRevenueUsd = protocolRevenue * (solPrice > 0 ? solPrice : 0);

    res.json({
      totalVaults,
      totalTransactions,
      transactionsUnshielded,
      totalVaultValue,
      totalVaultValueUsd,
      protocolRevenue,
      protocolRevenueUsd,
    });
  } catch (err) {
    req.log.error({ err }, "stats query failed");
    res.status(500).json({ error: "stats unavailable" });
  }
});

export default router;
