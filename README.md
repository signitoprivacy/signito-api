# signito-api

**Website:** [signito.org](https://signito.org)

Signito API Server — Express 5 backend for the Signito privacy protocol.


Handles vault metadata, StealthSend commitments, AirSign vouchers, Helius RPC proxying, and the SignitoRelay gasless fee payer.

---

## Features

- **SafeVault routes** — initialize, deposit, unshield, vault state queries
- **StealthSend routes** — commitment storage, nullifier-based withdrawal
- **AirSign routes** — voucher creation, pending claims, release
- **SignitoRelay** — gasless fee payer with rate limiting and tx simulation
- **Helius RPC proxy** — API key never exposed to the browser
- **OpenAPI 3.1 spec** — `lib/api-spec/openapi.yaml` is the single source of truth

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
    app.ts              Express app setup
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

- Validates fee payer matches its own public key before co-signing
- Simulates every transaction before signing
- Rate limits: 10 TX/hr per wallet, 20 TX/hr per IP
- Allowlist: only Signito program instructions accepted
- Controls only the fee pool — user funds protected by on-chain program logic

---

## Getting Started

```bash
pnpm install

cp .env.example .env
# Set DATABASE_URL, HELIUS_API_KEY, RELAY_KEYPAIR, SESSION_SECRET

# Push database schema
pnpm --filter @workspace/db run push

# Start dev server
pnpm dev   # → http://localhost:8080
```

## Build for Production

```bash
pnpm build
# Output: dist/index.mjs (ESM bundle via esbuild)
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `HELIUS_API_KEY` | Helius RPC key — [helius.dev](https://helius.dev) |
| `RELAY_KEYPAIR` | Base58 private key for SignitoRelay fee payer |
| `SESSION_SECRET` | Express session secret |
| `PORT` | Server port (default: 8080) |

---

## API Codegen

```bash
pnpm --filter @workspace/api-spec run codegen
# Generates React Query hooks → lib/api-client-react/
# Generates Zod schemas    → lib/api-zod/
```

---

## Related Repositories

| Repo | Description |
|---|---|
| [signito-programs](https://github.com/signitoprivacy/signito-programs) | On-chain Anchor/Rust program |
| [signito-app](https://github.com/signitoprivacy/signito-app) | Shield dApp frontend |
| [signito-docs](https://github.com/signitoprivacy/signito-docs) | Protocol documentation |

---

## License

MIT
