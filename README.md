# signito-api

**Website:** [signito.org](https://signito.org)

Signito API Server -- Express 5 backend for the Signito privacy protocol on Solana and Base chain.

Handles vault metadata, StealthSend commitments, AirSign vouchers, Helius RPC proxying, SignitoRelay gasless fee payer, and Base chain relayer operations.

---

## Features

- **SafeVault routes** -- shield, unshield, vault state, OTS chain management
- **StealthSend routes** -- commitment storage, nullifier-based withdrawal
- **AirSign routes** -- voucher creation, pending claims, release
- **SignitoRelay** -- gasless fee payer with rate limiting and tx simulation
- **Helius RPC proxy** -- Helius API key never exposed to the browser
- **Base chain routes** -- Base Sepolia shield/unshield with decoy mix layer
- **Mix pool worker** -- maintains 20-decoy anonymity sets on both chains

## Base Chain Routes

| Route | Description |
|---|---|
| `GET /base/status` | Pool balance, sETH supply, relayer address |
| `POST /base/vault/register` | Register shield, trigger `batchAdminMint` for 20 decoys |
| `GET /base/vault/state/:addr` | On-chain UserState (OTS hash, depth, deposited) |
| `POST /base/vault/unshield` | `burnAndQueue` (21 accounts) then `processQueue` |
| `GET /base/vault/history/:wallet` | Transaction history |

## Stack

- Node.js 24, Express 5, TypeScript 5.9
- Drizzle ORM + PostgreSQL
- Solana: `@solana/web3.js`, `@coral-xyz/anchor`
- Base chain: viem, Flashbots Protect RPC (mainnet)
- Logging: pino

## Solana Deployment

| Account | Address |
|---|---|
| Program ID | `HyciDEYB9hXdmmLMexTHv2QYDaJmuZr1AF7sipBbVLLH` |
| Pool PDA | `2vtb8aKBF1LjMoKBY8ihtFLnB9wfcwSXNw6kTRSNgi6L` |
| sSOL Mint | `B6CmtJ8VUeWYwqK8jnEBQGZVweBqBtNxdKBG8n2p4yLw` |

## Base Chain Deployment (Sepolia)

| Contract | Address |
|---|---|
| ShieldedETH (sETH) | `0x5e112428697dA966dC1603eA5cB96B71508c3a03` |
| SignitoPool | `0x8C7Eeb11C7c8D58b0d12A772B146313aaAAEaBdb` |
