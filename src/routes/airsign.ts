import { Router, type IRouter } from "express";
import { db, vaultsTable, airsignBalancesTable, airsignVouchersTable, transactionsTable, vaultBalancesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";

const router: IRouter = Router();

function sha256Hex(hex: string): string {
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}

function makeNonce(): string {
  return randomBytes(16).toString("hex");
}

function offchainSig(): string {
  return "offchain:" + randomBytes(16).toString("hex");
}

const PrepareBody = z.object({
  wallet: z.string().min(32).max(44),
  token: z.string().min(2).max(16),
  amount: z.number().positive(),
  preimage: z.string().length(64),
  expiryHours: z.number().int().min(1).max(8760).default(24),
});

// POST /airsign/prepare
// Converts sToken to aToken (airToken) for offline AirSign voucher.
// Step 1 of the AirSign flow: verifies OTS, mints aToken record, returns nonce.
router.post("/airsign/prepare", async (req, res): Promise<void> => {
  const parsed = PrepareBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, token, amount, preimage, expiryHours } = parsed.data;
  const sToken = "s" + token;
  const aToken = "a" + token;

  try {
    const [vault] = await db
      .select()
      .from(vaultsTable)
      .where(eq(vaultsTable.wallet, wallet));

    if (!vault) {
      res.status(404).json({ error: "Vault not found. Shield tokens first." });
      return;
    }

    if (!vault.lastOts) {
      res.status(400).json({ error: "Vault has no OTS tip" });
      return;
    }

    if (vault.chainDepth <= 0) {
      res.status(400).json({ error: "OTS chain exhausted. Vault depth is 0." });
      return;
    }

    // OTS verification: SHA-256(preimage) must equal current tip
    const computed = sha256Hex(preimage);
    if (computed !== vault.lastOts) {
      req.log.warn({ wallet, computed, tip: vault.lastOts }, "AirSign prep: OTS mismatch");
      res.status(400).json({ error: "Invalid vault code. OTS pre-image does not match." });
      return;
    }

    const newDepth = vault.chainDepth - 1;
    const nonce = makeNonce();
    const expiresAt = new Date(Date.now() + expiryHours * 3_600_000);

    // Update vault OTS tip (consumes one depth level)
    await db
      .update(vaultsTable)
      .set({ lastOts: preimage, chainDepth: newDepth })
      .where(eq(vaultsTable.wallet, wallet));

    // Mint aToken record in DB
    await db
      .insert(airsignBalancesTable)
      .values({
        wallet,
        token,
        aToken,
        amount: amount.toString(),
        nonce,
        claimed: false,
        expiresAt,
      });

    req.log.info({ wallet, aToken, amount, nonce, newDepth }, "AirSign prepare: aToken minted");

    try {
      await db.insert(transactionsTable).values({
        wallet,
        signature: offchainSig(),
        type: "mint",
        token: aToken,
        amount: amount.toFixed(9),
        status: "confirmed",
      });

      const [existing] = await db
        .select()
        .from(vaultBalancesTable)
        .where(
          and(
            eq(vaultBalancesTable.wallet, wallet),
            eq(vaultBalancesTable.token, sToken),
          ),
        );
      if (existing) {
        const next = Math.max(0, parseFloat(existing.shieldedAmount ?? "0") - amount);
        await db
          .update(vaultBalancesTable)
          .set({ shieldedAmount: next.toFixed(9) })
          .where(eq(vaultBalancesTable.id, existing.id));
      }
    } catch (recordErr) {
      req.log.warn({ recordErr }, "Failed to record mint transaction (non-fatal)");
    }

    res.json({
      success: true,
      aToken,
      amount,
      nonce,
      newChainDepth: newDepth,
      depthAtIssue: vault.chainDepth,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "AirSign prepare error");
    res.status(500).json({ error: "AirSign prepare failed" });
  }
});

// POST /airsign/create-voucher
// Step 2 of AirSign flow: stores binary Ed25519 signed voucher for a prepared nonce.
// The nonce must already exist in airsign_balances (created by /airsign/prepare).
const CreateVoucherBody = z.object({
  wallet: z.string().min(32).max(44),
  nonce: z.string().length(32),
  recipient: z.string().min(32).max(44),
  voucherMsgHex: z.string().length(128),
  sigHex: z.string().length(128),
  token: z.string().min(2).max(16),
  amount: z.number().positive(),
  depthAtIssue: z.number().int().positive(),
  expiresAt: z.string(),
});

router.post("/airsign/create-voucher", async (req, res): Promise<void> => {
  const parsed = CreateVoucherBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, nonce, recipient, voucherMsgHex, sigHex, token, amount, depthAtIssue, expiresAt } = parsed.data;

  try {
    // Verify the nonce exists in airsign_balances for this wallet
    const [balance] = await db
      .select()
      .from(airsignBalancesTable)
      .where(and(
        eq(airsignBalancesTable.nonce, nonce),
        eq(airsignBalancesTable.wallet, wallet),
      ));

    if (!balance) {
      res.status(404).json({ error: "Nonce not found. Call /airsign/prepare first." });
      return;
    }

    if (balance.claimed) {
      res.status(400).json({ error: "This nonce has already been used." });
      return;
    }

    // Verify the nonce in the binary voucher msg matches [40..56] bytes
    const nonceFromMsg = voucherMsgHex.slice(80, 112);
    if (nonceFromMsg !== nonce) {
      res.status(400).json({ error: "Voucher message nonce does not match prepared nonce." });
      return;
    }

    // Check for existing voucher with this nonce
    const [existing] = await db
      .select()
      .from(airsignVouchersTable)
      .where(eq(airsignVouchersTable.nonce, nonce));

    if (existing) {
      res.status(400).json({ error: "Voucher already created for this nonce." });
      return;
    }

    const expiresAtDate = new Date(expiresAt);
    if (isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() < Date.now()) {
      res.status(400).json({ error: "Voucher is already expired." });
      return;
    }

    await db.insert(airsignVouchersTable).values({
      issuerWallet: wallet,
      recipient,
      token,
      amount: amount.toString(),
      nonce,
      voucherMsgHex,
      sigHex,
      depthAtIssue: depthAtIssue.toString(),
      expiresAt: expiresAtDate,
      claimStatus: "unclaimed",
    });

    req.log.info({ wallet, nonce, recipient, amount, token }, "AirSign voucher created");

    res.json({ success: true, nonce, claimPath: `/claim/${nonce}` });
  } catch (err) {
    req.log.error({ err }, "AirSign create-voucher error");
    res.status(500).json({ error: "Failed to create voucher" });
  }
});

// GET /airsign/voucher/:nonce
// Returns public voucher details for the claim page.
router.get("/airsign/voucher/:nonce", async (req, res): Promise<void> => {
  const nonce = req.params.nonce as string;

  try {
    const [voucher] = await db
      .select()
      .from(airsignVouchersTable)
      .where(eq(airsignVouchersTable.nonce, nonce));

    if (!voucher) {
      res.status(404).json({ error: "Voucher not found" });
      return;
    }

    const now = Date.now();
    const expired = voucher.expiresAt.getTime() < now;

    res.json({
      nonce: voucher.nonce,
      issuerWallet: voucher.issuerWallet.slice(0, 8) + "..." + voucher.issuerWallet.slice(-6),
      recipient: voucher.recipient,
      token: voucher.token,
      amount: parseFloat(voucher.amount),
      expiresAt: voucher.expiresAt.toISOString(),
      claimStatus: expired && voucher.claimStatus === "unclaimed" ? "expired" : voucher.claimStatus,
      txSig: voucher.txSig ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "AirSign get-voucher error");
    res.status(500).json({ error: "Failed to fetch voucher" });
  }
});

// POST /airsign/voucher/:nonce/claim
// Recipient submits claim request. Sets claimerWallet and moves status to "pending".
const ClaimBody = z.object({
  claimerWallet: z.string().min(32).max(44),
});

router.post("/airsign/voucher/:nonce/claim", async (req, res): Promise<void> => {
  const nonce = req.params.nonce as string;
  const parsed = ClaimBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { claimerWallet } = parsed.data;

  try {
    const [voucher] = await db
      .select()
      .from(airsignVouchersTable)
      .where(eq(airsignVouchersTable.nonce, nonce));

    if (!voucher) {
      res.status(404).json({ error: "Voucher not found" });
      return;
    }

    if (voucher.expiresAt.getTime() < Date.now()) {
      res.status(400).json({ error: "Voucher has expired" });
      return;
    }

    if (voucher.claimStatus === "claimed") {
      res.status(400).json({ error: "Voucher already claimed" });
      return;
    }

    if (voucher.recipient !== claimerWallet) {
      res.status(400).json({ error: "Wallet does not match voucher recipient" });
      return;
    }

    await db
      .update(airsignVouchersTable)
      .set({ claimStatus: "pending", claimerWallet })
      .where(eq(airsignVouchersTable.nonce, nonce));

    req.log.info({ nonce, claimerWallet }, "AirSign voucher claim requested");

    res.json({ success: true, status: "pending" });
  } catch (err) {
    req.log.error({ err }, "AirSign voucher claim error");
    res.status(500).json({ error: "Failed to submit claim" });
  }
});

// GET /airsign/pending-claims/:issuerWallet
// Returns all pending claims for an issuer (so issuer can sign and release funds).
router.get("/airsign/pending-claims/:issuerWallet", async (req, res): Promise<void> => {
  const issuerWallet = req.params.issuerWallet as string;

  try {
    const rows = await db
      .select()
      .from(airsignVouchersTable)
      .where(and(
        eq(airsignVouchersTable.issuerWallet, issuerWallet),
        eq(airsignVouchersTable.claimStatus, "pending"),
      ));

    const claims = rows.map((r) => ({
      nonce: r.nonce,
      recipient: r.recipient,
      claimerWallet: r.claimerWallet,
      token: r.token,
      amount: parseFloat(r.amount),
      depthAtIssue: parseInt(r.depthAtIssue.toString()),
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));

    res.json({ issuerWallet, claims });
  } catch (err) {
    req.log.error({ err }, "AirSign pending-claims error");
    res.json({ issuerWallet, claims: [] });
  }
});

// POST /airsign/voucher/:nonce/release
// Issuer confirms the unshield tx was signed and broadcast. Marks voucher as claimed.
const ReleaseBody = z.object({
  issuerWallet: z.string().min(32).max(44),
  txSig: z.string().min(10),
});

router.post("/airsign/voucher/:nonce/release", async (req, res): Promise<void> => {
  const nonce = req.params.nonce as string;
  const parsed = ReleaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { issuerWallet, txSig } = parsed.data;

  try {
    const [voucher] = await db
      .select()
      .from(airsignVouchersTable)
      .where(eq(airsignVouchersTable.nonce, nonce));

    if (!voucher) {
      res.status(404).json({ error: "Voucher not found" });
      return;
    }

    if (voucher.issuerWallet !== issuerWallet) {
      res.status(403).json({ error: "Not the issuer of this voucher" });
      return;
    }

    if (voucher.claimStatus === "claimed") {
      res.status(400).json({ error: "Already claimed" });
      return;
    }

    await db
      .update(airsignVouchersTable)
      .set({ claimStatus: "claimed", txSig })
      .where(eq(airsignVouchersTable.nonce, nonce));

    // Record unshield transaction
    try {
      await db.insert(transactionsTable).values({
        wallet: issuerWallet,
        signature: txSig,
        type: "unshield",
        token: voucher.token,
        amount: parseFloat(voucher.amount).toFixed(9),
        status: "confirmed",
      });
    } catch {
      // non-fatal
    }

    req.log.info({ nonce, issuerWallet, txSig }, "AirSign voucher released");

    res.json({ success: true, status: "claimed", txSig });
  } catch (err) {
    req.log.error({ err }, "AirSign voucher release error");
    res.status(500).json({ error: "Failed to release voucher" });
  }
});

// GET /airsign/balances/:wallet
// Returns all unclaimed aToken balances for a wallet.
router.get("/airsign/balances/:wallet", async (req, res): Promise<void> => {
  const wallet = req.params.wallet as string;

  try {
    const rows = await db
      .select()
      .from(airsignBalancesTable)
      .where(and(
        eq(airsignBalancesTable.wallet, wallet),
        eq(airsignBalancesTable.claimed, false)
      ));

    const balances = rows.map((r) => ({
      id: r.id,
      token: r.token,
      aToken: r.aToken,
      amount: parseFloat(r.amount),
      nonce: r.nonce,
      claimed: r.claimed,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));

    res.json({ wallet, balances });
  } catch (err) {
    req.log.error({ err }, "AirSign balances fetch error");
    res.json({ wallet, balances: [] });
  }
});

export default router;
