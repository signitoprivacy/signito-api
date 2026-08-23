# Signito API

Signito API coordinates public client requests with chain specific relayers and privacy set readiness checks.

## Supported networks

* Solana standard pool operations
* Base standard operations and opt in Private Execution
* Ethereum standard operations and opt in Private Execution

Private Execution requires exactly twenty funded usable decoys before processing begins. Decoy preparation is paid by the operational relayer. Submitted EVM hashes are reconciled as pending before any retry decision.

## Development

Install workspace dependencies, generate API client code from the OpenAPI specification when it changes, then run typecheck and tests. Keep private keys and operational environment values in a private secret manager.

## Public release policy

Do not commit binary program artifacts, build output, local environment files, keys, transaction evidence, or deployment records containing nonpublic operational detail.
