import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vaultsTable = pgTable("vaults", {
  id: serial("id").primaryKey(),
  wallet: text("wallet").notNull().unique(),
  chainDepth: integer("chain_depth").notNull().default(0),
  lastOts: text("last_ots"),
  mint: text("mint"),
  stokenAccount: text("stoken_account"),
  // Base58-encoded secret key of the freshWallet used as `owner` in the shield ix.
  // Stored so the server can sign future deposit/refresh_ots/close_account instructions
  // on behalf of this vault without the user signing a program instruction.
  // null for vaults created before the two-actor upgrade.
  ownerKeypair: text("owner_keypair"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVaultSchema = createInsertSchema(vaultsTable).omit({ id: true, createdAt: true });
export type InsertVault = z.infer<typeof insertVaultSchema>;
export type Vault = typeof vaultsTable.$inferSelect;
