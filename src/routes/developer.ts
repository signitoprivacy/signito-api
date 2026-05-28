import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { devRegistrationsTable, apiKeysTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

const router: IRouter = Router();

const registerSchema = z.object({
  wallet: z.string().min(32).max(44),
  email:  z.string().email().optional(),
});

router.post("/developer/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }
  const { wallet, email } = parsed.data;

  try {
    const existing = await db
      .select()
      .from(devRegistrationsTable)
      .where(eq(devRegistrationsTable.wallet, wallet))
      .limit(1);

    if (existing.length > 0) {
      res.json({ status: existing[0].status, message: "Already registered" });
      return;
    }

    await db.insert(devRegistrationsTable).values({
      wallet,
      email: email ?? null,
      status: "pending",
    });

    res.json({ status: "pending", message: "Registered for early access" });
  } catch (err) {
    req.log.error({ err }, "developer register error");
    res.status(500).json({ error: "Registration failed" });
  }
});

router.get("/developer/status/:wallet", async (req, res) => {
  const wallet = req.params["wallet"];
  if (!wallet || wallet.length < 32) {
    res.status(400).json({ error: "Invalid wallet" });
    return;
  }

  try {
    const reg = await db
      .select()
      .from(devRegistrationsTable)
      .where(eq(devRegistrationsTable.wallet, wallet))
      .limit(1);

    if (reg.length === 0) {
      res.json({ registered: false });
      return;
    }

    const keys = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.wallet, wallet))
      .limit(1);

    const activeKey = keys.find((k) => k.status === "active");

    res.json({
      registered: true,
      status:     reg[0].status,
      hasApiKey:  !!activeKey,
      keyPrefix:  activeKey?.keyPrefix ?? null,
      expiresAt:  activeKey?.expiresAt ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "developer status error");
    res.status(500).json({ error: "Status check failed" });
  }
});

export default router;
