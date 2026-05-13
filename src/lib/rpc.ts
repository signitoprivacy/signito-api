export function heliusRpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  const cluster = process.env.SOLANA_CLUSTER === "devnet" ? "devnet" : "mainnet";
  if (key) return `https://${cluster}.helius-rpc.com/?api-key=${key}`;
  return cluster === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com";
}
