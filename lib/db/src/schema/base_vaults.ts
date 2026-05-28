import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const baseVaultsTable = pgTable("base_vaults", {
  id: serial("id").primaryKey(),
  wallet: text("wallet").notNull(),
  stokenAddress: text("stoken_address").notNull().unique(),
  chainDepth: integer("chain_depth").notNull().default(32),
  generation: integer("generation").notNull().default(0),
  lastOtsHash: text("last_ots_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBaseVaultSchema = createInsertSchema(baseVaultsTable).omit({ id: true, createdAt: true });
export type InsertBaseVault = z.infer<typeof insertBaseVaultSchema>;
export type BaseVault = typeof baseVaultsTable.$inferSelect;
