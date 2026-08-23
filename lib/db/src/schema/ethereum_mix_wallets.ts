import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ethereumMixWalletsTable = pgTable("ethereum_mix_wallets", {
  id: serial("id").primaryKey(),
  stokenAddress: text("stoken_address").notNull().unique(),
  balance: text("balance").notNull().default("0"),
  status: text("status").notNull().default("ready"),
  linkedStokenAddress: text("linked_stoken_address"),
  mintedAmount: text("minted_amount").notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertEthereumMixWalletSchema = createInsertSchema(ethereumMixWalletsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertEthereumMixWallet = z.infer<typeof insertEthereumMixWalletSchema>;
export type EthereumMixWallet = typeof ethereumMixWalletsTable.$inferSelect;