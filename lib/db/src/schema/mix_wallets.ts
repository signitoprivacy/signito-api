import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";

// Mix wallet pool: pre-generated keypairs used by the shield/unshield mix layer.
//
// Lifecycle:
//   ready      - keypair generated, secret key stored, no on-chain state yet.
//                Used as decoy_shield signer when a real user shields.
//   available  - decoy_shield was executed (has sSOL). Ready for decoy_burn.
//                secret_key no longer needed (pool_pda PermanentDelegate handles burns).
//   in_use     - selected for an in-flight unshield TX (reserved, not yet confirmed).
//   depleted   - sSOL was burned by decoy_burn. Awaiting close_decoy for rent recovery.
//   closed     - close_decoy confirmed. On-chain account gone. Row deleted after this state.
//
// On-chain state is created ONLY when a real user action (shield/unshield/zksend)
// occurs -- never upfront by the background worker. The worker only generates keypairs.
export const mixWalletsTable = pgTable("mix_wallets", {
  id: serial("id").primaryKey(),
  stokenAta: text("stoken_ata").notNull().unique(),
  secretKey: text("secret_key"),                          // base64 secret key for stoken_ata keypair ("ready" only)
  displayOwner: text("display_owner").notNull(),          // pubkey of the fresh wallet set as token account owner
  displayOwnerSecret: text("display_owner_secret"),       // base64 secret key for display owner keypair (kept until row deleted)
  amountLamports: text("amount_lamports").notNull().default("0"),
  status: text("status").notNull().default("ready"),      // ready | available | in_use | depleted
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export type MixWallet = typeof mixWalletsTable.$inferSelect;
