import { Router, type IRouter } from "express";
import { db, vaultsTable, transactionsTable } from "@workspace/db";
import { count, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/stats", async (req, res): Promise<void> => {
  try {
    const [vaultCount] = await db.select({ value: count() }).from(vaultsTable);
    const [txCount] = await db.select({ value: count() }).from(transactionsTable);
    const [otsSum] = await db
      .select({ value: sql<number>`coalesce(sum(${vaultsTable.chainDepth}), 0)` })
      .from(vaultsTable);
    const [vaultValue] = await db
      .select({ value: sql<number>`coalesce(sum(${transactionsTable.amount}::numeric), 0)` })
      .from(transactionsTable);

    res.json({
      totalVaults: vaultCount?.value ?? 0,
      totalTransactions: txCount?.value ?? 0,
      transactionsUnshielded: Number(otsSum?.value ?? 0),
      totalVaultValue: Number(vaultValue?.value ?? 0),
    });
  } catch (err) {
    req.log.error({ err }, "stats query failed");
    res.status(500).json({ error: "stats unavailable" });
  }
});

export default router;
