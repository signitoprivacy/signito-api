import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";

export const pendingDepositsTable = pgTable("pending_deposits", {
  id: serial("id").primaryKey(),
  pendingId: text("pending_id").notNull().unique(),
  wallet: text("wallet").notNull(),
  freshDepositWalletKeypair: text("fresh_deposit_wallet_keypair").notNull(),
  amountLamports: text("amount_lamports").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PendingDepositRow = typeof pendingDepositsTable.$inferSelect;
