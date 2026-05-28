import { pgTable, text, serial, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const airsignVouchersTable = pgTable("airsign_vouchers", {
  id: serial("id").primaryKey(),
  issuerWallet: text("issuer_wallet").notNull(),
  recipient: text("recipient"),
  token: text("token").notNull(),
  amount: numeric("amount", { precision: 20, scale: 9 }).notNull(),
  nonce: text("nonce").notNull().unique(),
  nonceHash: text("nonce_hash").notNull().unique(),
  escrowPda: text("escrow_pda").notNull(),
  voucherMsgHex: text("voucher_msg_hex"),
  sigHex: text("sig_hex"),
  mintTxSig: text("mint_tx_sig"),
  claimStatus: text("claim_status").notNull().default("minted"),
  txSig: text("tx_sig"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAirsignVoucherSchema = createInsertSchema(airsignVouchersTable).omit({
  id: true,
  createdAt: true,
  txSig: true,
});
export type InsertAirsignVoucher = z.infer<typeof insertAirsignVoucherSchema>;
export type AirsignVoucher = typeof airsignVouchersTable.$inferSelect;
