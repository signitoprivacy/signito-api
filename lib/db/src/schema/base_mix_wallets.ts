import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const baseMixWalletsTable = pgTable("base_mix_wallets", {
  id: serial("id").primaryKey(),
  stokenAddress: text("stoken_address").notNull().unique(),
  balance: text("balance").notNull().default("0"),
  status: text("status").notNull().default("ready"),
  linkedStokenAddress: text("linked_stoken_address"),
  mintedAmount: text("minted_amount").notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBaseMixWalletSchema = createInsertSchema(baseMixWalletsTable).omit({ id: true, createdAt: true });
export type InsertBaseMixWallet = z.infer<typeof insertBaseMixWalletSchema>;
export type BaseMixWallet = typeof baseMixWalletsTable.$inferSelect;
