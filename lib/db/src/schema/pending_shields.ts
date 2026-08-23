import { pgTable, text, serial, bigint, timestamp } from "drizzle-orm/pg-core";

// Ephemeral pending shield records — persisted so keypairs survive server restarts.
// Deleted on success or expiry. TTL enforced at application level.
export const pendingShieldsTable = pgTable("solana_v4_pending_shields", {
  id: serial("id").primaryKey(),
  // Opaque random token returned to the client as the pending ID
  pendingId: text("pending_id").notNull().unique(),
  // User's wallet address
  wallet: text("wallet").notNull(),
  // Base58-encoded secret keys for ephemeral keypairs
  freshWalletKeypair: text("fresh_wallet_keypair").notNull(),
  stokenAtaKeypair: text("stoken_ata_keypair").notNull(),
  // Mint and pool addresses at time of prepare
  mintStoken: text("mint_stoken").notNull(),
  poolPda: text("pool_pda").notNull(),
  // OTS state
  codeHash: text("code_hash").notNull(),
  chainDepth: bigint("chain_depth", { mode: "number" }).notNull(),
  // Lamports
  amountLamports: text("amount_lamports").notNull(),
  rentExtra: text("rent_extra").notNull(),
  // Set after broadcast so shield-status endpoint can look it up by wallet
  txSig: text("tx_sig"),
  // Expiry timestamp
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PendingShieldRow = typeof pendingShieldsTable.$inferSelect;
