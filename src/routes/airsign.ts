import { Router, type IRouter } from "express";
import { db, vaultsTable, airsignVouchersTable, transactionsTable, vaultBalancesTable } from "@workspace/db";
import { eq, isNull, and } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { heliusRpcUrl } from "../lib/rpc.js";
import {
  buildMintAirsignIx,
  buildClaimAirsignIx,
  buildEd25519SigVerifyIx,
  buildVersionedTx,
  deriveAirsignEscrowPda,
} from "@workspace/program";

const router: IRouter = Router();

function sha256(input: Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}

function getRpcConnection(): Connection {
  return new Connection(heliusRpcUrl(), "confirmed");
}

function getRelayerKeypair(): Keypair {
  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) throw new Error("RELAYER_PRIVATE_KEY not set");
  const bytes = bs58.decode(key);
  return Keypair.fromSecretKey(bytes);
}

// POST /airsign/mint
// Step 1: Burns sSOL on-chain (OTS-verified, relayer-mediated), locks SOL in AirsignEscrow PDA.
// No recipient required at this stage. Nonce is generated server-side.
// Use POST /airsign/attach-voucher to assign recipient and sign the voucher (Step 2).

const MintBody = z.object({
  wallet: z.string().min(32).max(44),
  otsPreimage: z.string().length(64),
  amount: z.number().positive(),
  token: z.string().min(2).max(16),
});

router.post("/airsign/mint", async (req, res): Promise<void> => {
  const parsed = MintBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, otsPreimage, amount, token } = parsed.data;

  try {
    const [vault] = await db.select().from(vaultsTable).where(eq(vaultsTable.wallet, wallet));

    if (!vault) {
      res.status(404).json({ error: "Vault not found. Shield tokens first." });
      return;
    }
    if (!vault.lastOts) {
      res.status(400).json({ error: "Vault has no OTS tip. Re-initialize vault." });
      return;
    }
    if (vault.chainDepth <= 0) {
      res.status(400).json({ error: "OTS chain exhausted. Refresh vault first." });
      return;
    }
    if (!vault.mint || !vault.stokenAccount) {
      res.status(400).json({ error: "Vault missing sToken info." });
      return;
    }

    // Verify OTS preimage
    const computedOts = createHash("sha256").update(Buffer.from(otsPreimage, "hex")).digest("hex");
    if (computedOts !== vault.lastOts) {
      req.log.warn({ wallet, computedOts, tip: vault.lastOts }, "AirSign mint: OTS mismatch");
      res.status(400).json({ error: "Invalid vault code. OTS pre-image does not match." });
      return;
    }

    // Generate nonce server-side
    const nonceBuf = randomBytes(16);
    const nonce = nonceBuf.toString("hex");
    const nonceHashBuf = sha256(nonceBuf);
    const nonceHash = nonceHashBuf.toString("hex");

    // Check for duplicate nonce (very unlikely but guard anyway)
    const [existing] = await db
      .select().from(airsignVouchersTable).where(eq(airsignVouchersTable.nonce, nonce));
    if (existing) {
      res.status(400).json({ error: "Nonce collision. Please retry." });
      return;
    }

    const amountLamports = BigInt(Math.round(amount * 1_000_000_000));
    const otsPreimageBuf = Buffer.from(otsPreimage, "hex");
    const relayer = getRelayerKeypair();
    const connection = getRpcConnection();
    const mintStoken = new PublicKey(vault.mint);
    const stokenAta = new PublicKey(vault.stokenAccount);

    const ix = buildMintAirsignIx(relayer.publicKey, mintStoken, stokenAta, {
      otsPreimage: otsPreimageBuf,
      amount: amountLamports,
      nonceHash: nonceHashBuf,
    });

    const tx = await buildVersionedTx(connection, relayer.publicKey, [ix], [relayer]);
    const txSig = await connection.sendTransaction(tx, { skipPreflight: false });
    await connection.confirmTransaction(txSig, "confirmed");

    // Advance OTS chain in DB
    await db
      .update(vaultsTable)
      .set({ lastOts: otsPreimage, chainDepth: vault.chainDepth - 1 })
      .where(eq(vaultsTable.wallet, wallet));

    // Decrement sSOL vault balance ledger so the UI reflects the burn immediately
    const sToken = "s" + token;
    const [balRow] = await db
      .select()
      .from(vaultBalancesTable)
      .where(and(eq(vaultBalancesTable.wallet, wallet), eq(vaultBalancesTable.token, sToken)));
    if (balRow) {
      const current = parseFloat(balRow.shieldedAmount ?? "0");
      const next = Math.max(0, current - amount);
      await db
        .update(vaultBalancesTable)
        .set({ shieldedAmount: next.toFixed(9) })
        .where(eq(vaultBalancesTable.id, balRow.id));
    }

    const [escrowPda] = deriveAirsignEscrowPda(nonceHashBuf);

    // Store mint in DB -- no recipient or voucher yet
    await db.insert(airsignVouchersTable).values({
      issuerWallet: wallet,
      token,
      amount: amount.toString(),
      nonce,
      nonceHash,
      escrowPda: escrowPda.toBase58(),
      mintTxSig: txSig,
      claimStatus: "minted",
    });

    try {
      await db.insert(transactionsTable).values({
        wallet,
        signature: txSig,
        type: "mint",
        token: "a" + token,
        amount: amount.toFixed(9),
        status: "confirmed",
      });
    } catch { /* non-fatal */ }

    req.log.info({ wallet, nonce, escrowPda: escrowPda.toBase58(), amount, txSig }, "AirSign minted");

    res.json({
      success: true,
      escrowPda: escrowPda.toBase58(),
      nonce,
      txSig,
      newDepth: vault.chainDepth - 1,
    });
  } catch (err) {
    req.log.error({ err }, "AirSign mint error");
    res.status(500).json({ error: "AirSign mint failed" });
  }
});

// POST /airsign/attach-voucher
// Step 2: Attach Ed25519 voucher to an existing minted aSOL escrow.
// Issuer signs offline (Phantom signMessage), then calls this to store the voucher.
// Voucher message format (57 bytes): [0] 0x53 domain sep, [1..9] amount u64LE, [9..41] recipient pubkey, [41..57] nonce 16 bytes.

const AttachVoucherBody = z.object({
  wallet: z.string().min(32).max(44),
  nonce: z.string().length(32),
  voucherMsgHex: z.string().length(114), // 57 bytes * 2
  sigHex: z.string().length(128),
});

router.post("/airsign/attach-voucher", async (req, res): Promise<void> => {
  const parsed = AttachVoucherBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { wallet, nonce, voucherMsgHex, sigHex } = parsed.data;

  try {
    const [row] = await db
      .select()
      .from(airsignVouchersTable)
      .where(eq(airsignVouchersTable.nonce, nonce));

    if (!row) {
      res.status(404).json({ error: "Mint not found for this nonce." });
      return;
    }

    if (row.issuerWallet !== wallet) {
      res.status(403).json({ error: "Wallet does not match issuer." });
      return;
    }

    if (row.voucherMsgHex !== null) {
      res.status(400).json({ error: "Voucher already attached to this mint." });
      return;
    }

    if (row.claimStatus !== "minted") {
      res.status(400).json({ error: "Mint is not in a state that accepts a voucher." });
      return;
    }

    // Verify Ed25519 signature
    const voucherMsgBuf = Buffer.from(voucherMsgHex, "hex");
    const sigBuf = Buffer.from(sigHex, "hex");
    const issuerPubkey = new PublicKey(wallet);
    const isValidSig = nacl.sign.detached.verify(voucherMsgBuf, sigBuf, issuerPubkey.toBytes());
    if (!isValidSig) {
      req.log.warn({ wallet }, "AirSign attach-voucher: Ed25519 sig invalid");
      res.status(400).json({ error: "Ed25519 signature verification failed." });
      return;
    }

    // Validate domain separator
    if (voucherMsgBuf[0] !== 0x53) {
      res.status(400).json({ error: "Invalid voucher message format (missing domain separator)." });
      return;
    }

    // Validate nonce in voucher message matches DB nonce (bytes [41..57])
    const msgNonce = voucherMsgBuf.slice(41, 57).toString("hex");
    if (msgNonce !== nonce) {
      res.status(400).json({ error: "Nonce in voucher message does not match mint nonce." });
      return;
    }

    // Extract recipient from voucher message bytes [9..41]
    const recipient = new PublicKey(voucherMsgBuf.slice(9, 41)).toBase58();

    // Update DB row with voucher data
    await db
      .update(airsignVouchersTable)
      .set({ recipient, voucherMsgHex, sigHex, claimStatus: "unclaimed" })
      .where(eq(airsignVouchersTable.nonce, nonce));

    req.log.info({ wallet, nonce, recipient }, "AirSign voucher attached");

    res.json({
      success: true,
      claimPath: `/claim/${nonce}`,
      recipient,
    });
  } catch (err) {
    req.log.error({ err }, "AirSign attach-voucher error");
    res.status(500).json({ error: "Attach voucher failed" });
  }
});

// GET /airsign/mints/:wallet
// Returns minted aSOL escrows that have no voucher attached yet (claimStatus = "minted").

router.get("/airsign/mints/:wallet", async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  const wallet = req.params.wallet as string;
  try {
    const rows = await db
      .select()
      .from(airsignVouchersTable)
      .where(eq(airsignVouchersTable.issuerWallet, wallet));

    const mints = rows
      .filter((r) => r.claimStatus === "minted" && r.voucherMsgHex === null)
      .map((r) => ({
        nonce: r.nonce,
        token: r.token,
        amount: parseFloat(r.amount),
        escrowPda: r.escrowPda,
        mintTxSig: r.mintTxSig ?? null,
        createdAt: r.createdAt.toISOString(),
      }));

    res.json({ mints });
  } catch (err) {
    req.log.error({ err }, "AirSign list-mints error");
    res.status(500).json({ error: "Failed to fetch mints" });
  }
});

// GET /airsign/vouchers/:wallet
// Returns all vouchers issued by this wallet (from DB).

router.get("/airsign/vouchers/:wallet", async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  const wallet = req.params.wallet as string;
  try {
    const rows = await db
      .select()
      .from(airsignVouchersTable)
      .where(eq(airsignVouchersTable.issuerWallet, wallet));

    const vouchers = rows
      .filter((r) => r.claimStatus !== "minted")
      .map((v) => ({
        nonce: v.nonce,
        token: v.token,
        amount: parseFloat(v.amount),
        claimStatus: v.claimStatus,
        escrowPda: v.escrowPda,
        createdAt: v.createdAt.toISOString(),
      }));

    res.json({ vouchers });
  } catch (err) {
    req.log.error({ err }, "AirSign list-vouchers error");
    res.status(500).json({ error: "Failed to fetch vouchers" });
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

    if (!voucher.voucherMsgHex) {
      res.status(400).json({ error: "Voucher not yet attached. Complete step 2 first." });
      return;
    }

    res.json({
      nonce: voucher.nonce,
      issuerWallet: voucher.issuerWallet.slice(0, 8) + "..." + voucher.issuerWallet.slice(-6),
      recipient: voucher.recipient,
      token: voucher.token,
      amount: parseFloat(voucher.amount),
      claimStatus: voucher.claimStatus,
      escrowPda: voucher.escrowPda,
      txSig: voucher.txSig ?? null,
      createdAt: voucher.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "AirSign get-voucher error");
    res.status(500).json({ error: "Failed to fetch voucher" });
  }
});

// POST /airsign/voucher/:nonce/claim
// Execute on-chain claim: verify Ed25519 sig, release escrowed SOL to fixed recipient.

router.post("/airsign/voucher/:nonce/claim", async (req, res): Promise<void> => {
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

    if (!voucher.voucherMsgHex || !voucher.sigHex || !voucher.recipient) {
      res.status(400).json({ error: "Voucher not ready for claim. Attach voucher first." });
      return;
    }

    if (voucher.claimStatus === "claimed") {
      res.status(400).json({ error: "Voucher already claimed" });
      return;
    }

    if (voucher.claimStatus === "processing") {
      res.status(400).json({ error: "Claim already in progress" });
      return;
    }

    // Mark as processing to prevent double-claim
    await db
      .update(airsignVouchersTable)
      .set({ claimStatus: "processing" })
      .where(eq(airsignVouchersTable.nonce, nonce));

    try {
      const relayer = getRelayerKeypair();
      const connection = getRpcConnection();

      const issuer = new PublicKey(voucher.issuerWallet);
      const recipient = new PublicKey(voucher.recipient);
      const voucherMsgBuf = Buffer.from(voucher.voucherMsgHex, "hex");
      const sigBuf = Buffer.from(voucher.sigHex, "hex");
      const nonceHashBuf = Buffer.from(voucher.nonceHash, "hex");

      const ed25519Ix = buildEd25519SigVerifyIx(
        issuer.toBytes(),
        voucherMsgBuf,
        sigBuf
      );

      const claimIx = buildClaimAirsignIx(relayer.publicKey, issuer, recipient, {
        nonceHash: nonceHashBuf,
        voucherMsg: voucherMsgBuf,
        sig: sigBuf,
      });

      const tx = await buildVersionedTx(connection, relayer.publicKey, [ed25519Ix, claimIx], [relayer]);
      const txSig = await connection.sendTransaction(tx, { skipPreflight: false });
      await connection.confirmTransaction(txSig, "confirmed");

      await db
        .update(airsignVouchersTable)
        .set({ claimStatus: "claimed", txSig })
        .where(eq(airsignVouchersTable.nonce, nonce));

      try {
        await db.insert(transactionsTable).values({
          wallet: voucher.issuerWallet,
          signature: txSig,
          type: "unshield",
          token: voucher.token,
          amount: parseFloat(voucher.amount).toFixed(9),
          status: "confirmed",
        });
      } catch { /* non-fatal */ }

      req.log.info({ nonce, txSig, recipient: voucher.recipient }, "AirSign claimed");

      res.json({ success: true, txSig, recipient: voucher.recipient });
    } catch (claimErr) {
      await db
        .update(airsignVouchersTable)
        .set({ claimStatus: "unclaimed" })
        .where(eq(airsignVouchersTable.nonce, nonce));
      throw claimErr;
    }
  } catch (err) {
    req.log.error({ err }, "AirSign claim error");
    res.status(500).json({ error: "Claim failed" });
  }
});

export default router;
