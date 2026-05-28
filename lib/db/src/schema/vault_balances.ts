import { pgTable, text, serial, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vaultBalancesTable = pgTable("vault_balances", {
  id: serial("id").primaryKey(),
  wallet: text("wallet").notNull(),
  token: text("token").notNull(),
  mint: text("mint").notNull(),
  shieldedAmount: numeric("shielded_amount", { precision: 20, scale: 9 }).notNull().default("0"),
  decimals: integer("decimals").notNull().default(9),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVaultBalanceSchema = createInsertSchema(vaultBalancesTable).omit({ id: true, updatedAt: true });
export type InsertVaultBalance = z.infer<typeof insertVaultBalanceSchema>;
export type VaultBalance = typeof vaultBalancesTable.$inferSelect;
