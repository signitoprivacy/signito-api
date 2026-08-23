import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ethereumStealthPendingTable = pgTable("ethereum_stealth_pending", {
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

export const insertEthereumStealthPendingSchema = createInsertSchema(
  ethereumStealthPendingTable
).omit({ id: true, createdAt: true });
export type InsertEthereumStealthPending = z.infer<typeof insertEthereumStealthPendingSchema>;
export type EthereumStealthPending = typeof ethereumStealthPendingTable.$inferSelect;