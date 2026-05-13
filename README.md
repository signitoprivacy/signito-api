# signito-api

Signito API Server — Express 5 backend for the Signito privacy protocol.

Handles vault metadata, StealthSend commitments, AirSign vouchers, Helius RPC proxying, and the SignitoRelay gasless fee payer.

---

## Features

- **SafeVault routes** — initialize, deposit, unshield, vault state queries
- **StealthSend routes** — commitment storage, nullifier-based withdrawal
- **AirSign routes** — voucher creation, pending claims, release
- **SignitoRelay** — in-process gasless fee payer with rate limiting and transaction simulation
- **Helius RPC proxy** — API key never exposed to the browser
- **OpenAPI 3.1 spec** — `lib/api-spec/openapi.yaml` is the source of truth

---

## Project Structure

```
signito-api/
  src/
    routes/
      health.ts         GET /healthz
      status.ts         GET /status, GET /stats
      rpc.ts            POST /rpc/mainnet, GET /rpc/cluster
      portfolio.ts      GET /portfolio/:wallet
      transactions.ts   GET /transactions/:wallet
      relay.ts          GET /relay/info, POST /relay
      vault.ts          SafeVault + AirSign endpoints
      stealth.ts        StealthSend endpoints
      airsign.ts        AirSign voucher lifecycle
    lib/
      relayer.ts        SignitoRelay keypair, rate limiter, tx simulation
      rpc.ts            Helius RPC connection singleton
    app.ts              Express app setup, middleware, route mounting
    index.ts            Server entrypoint
  lib/
    api-spec/
      openapi.yaml      OpenAPI 3.1 source of truth
    api-zod/            Generated Zod validation schemas
    db/
      src/schema/       Drizzle ORM table definitions
```

---

## Database Schema

| Table | Key Columns |
|---|---|
| `vaults` | wallet, chainDepth, lastOts, mint, stokenAccount |
| `transactions` | signature, type, status, token, amount |
| `vault_balances` | wallet, token, mint, shieldedAmount |
| `stealth_pending` | commitment, nullifierHash, amount, spentAt |
| `airsign_vouchers` | nonce, issuerWallet, recipient, voucherMsgHex, sigHex, status |

---

## SignitoRelay Trust Model

- Validates fee payer field matches its own public key
- Simulates every transaction before co-signing
- Rate limits: 10 TX/hr per wallet, 20 TX/hr per IP
- Only accepts instructions from the Signito program (allowlist enforced)
- Controls only the fee pool — user funds are protected by on-chain program logic

---

## Getting Started

```bash
# Install dependencies
pnpm install

# Set environment variables
cp .env.example .env

# Push database schema (requires DATABASE_URL)
pnpm --filter @workspace/db run push

# Start dev server (port 8080)
pnpm dev
```

## Build for Production

```bash
pnpm build
# Output: dist/index.mjs (ESM CJS bundle via esbuild)
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `HELIUS_API_KEY` | Helius RPC key (get free at helius.dev) |
| `RELAY_KEYPAIR` | Base58 private key for SignitoRelay fee payer |
| `SESSION_SECRET` | Express session secret |
| `PORT` | Server port (default: 8080) |

---

## API Codegen

The OpenAPI spec at `lib/api-spec/openapi.yaml` generates React Query hooks and Zod schemas:

```bash
pnpm --filter @workspace/api-spec run codegen
```

---

## License

MIT
