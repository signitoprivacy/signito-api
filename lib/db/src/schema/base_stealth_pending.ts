import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const baseStealthPendingTable = pgTable("base_stealth_pending", {
  id: serial("id").primaryKey(),
  wallet: text("wallet").notNull(),
  stokenAddress: text("stoken_address").notNull(),
  amount: text("amount").notNull(),
  recipient: text("recipient").notNull(),
  action: text("action").notNull().default("unshield"),
  burnTxHash: text("burn_tx_hash"),
  processTxHash: text("process_tx_hash"),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBaseStealthPendingSchema = createInsertSchema(baseStealthPendingTable).omit({ id: true, createdAt: true });
export type InsertBaseStealthPending = z.infer<typeof insertBaseStealthPendingSchema>;
export type BaseStealthPending = typeof baseStealthPendingTable.$inferSelect;
