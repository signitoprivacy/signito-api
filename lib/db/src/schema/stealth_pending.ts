import { pgTable, text, serial, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const stealthPendingTable = pgTable("stealth_pending", {
  id: serial("id").primaryKey(),
  wallet: text("wallet").notNull(),
  commitment: text("commitment").notNull(),
  nullifier: text("nullifier"),
  amount: numeric("amount"),
  token: text("token"),
  depositTxSig: text("deposit_tx_sig"),
  withdrawTxSig: text("withdraw_tx_sig"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertStealthPendingSchema = createInsertSchema(stealthPendingTable).omit({ id: true, createdAt: true });
export type InsertStealthPending = z.infer<typeof insertStealthPendingSchema>;
export type StealthPending = typeof stealthPendingTable.$inferSelect;
