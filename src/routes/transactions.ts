import { Router, type IRouter } from "express";
import { db, transactionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/transactions/:wallet", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.wallet) ? req.params.wallet[0] : req.params.wallet;
  const wallet = raw as string;

  try {
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.wallet, wallet))
      .orderBy(transactionsTable.createdAt);

    const transactions = rows.map((r) => ({
      signature: r.signature,
      type: r.type,
      timestamp: r.createdAt ? Math.floor(new Date(r.createdAt).getTime() / 1000) : null,
      status: r.status,
      token: r.token ?? null,
      amount: r.amount != null ? parseFloat(r.amount) : null,
    }));

    res.json({ wallet, transactions });
  } catch (err) {
    req.log.error({ err }, "Transactions fetch error");
    res.json({ wallet, transactions: [] });
  }
});

export default router;
