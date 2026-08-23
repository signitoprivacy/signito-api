export const SOLANA_DEVNET_PROGRAM_ID =
  "5gbaenRHg2YK6X8WMMQZevD55bJ7fvr4V8E8e1feDt5D";
export const SOLANA_APPROVED_MAINNET_TARGET_PROGRAM_ID =
  "7uk33yDcb5CexkuUjcg2u3RBaBZGARMo1FU41cE39peD";

export function getSolanaCluster(): "devnet" | "mainnet" {
  return process.env.SOLANA_CLUSTER === "devnet" ? "devnet" : "mainnet";
}

export function getActiveSolanaProgramId(): string {
  if (getSolanaCluster() === "devnet") return SOLANA_DEVNET_PROGRAM_ID;

  const configured = process.env.SOLANA_MAINNET_PROGRAM_ID;
  if (!configured) return SOLANA_APPROVED_MAINNET_TARGET_PROGRAM_ID;
  if (configured !== SOLANA_APPROVED_MAINNET_TARGET_PROGRAM_ID) {
    throw new Error(
      "SOLANA_MAINNET_PROGRAM_ID must be the approved new Mainnet target. Refusing an unapproved program ID."
    );
  }
  return configured;
}

export function isApprovedSolanaTargetActive(): boolean {
  return getActiveSolanaProgramId() === SOLANA_APPROVED_MAINNET_TARGET_PROGRAM_ID;
}