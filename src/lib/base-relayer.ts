import { createPublicClient, createWalletClient, http, fallback } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { logger } from "./logger.js";

const RAW_KEY = process.env.BASE_RELAYER_PRIVATE_KEY;

if (!RAW_KEY) {
  logger.warn("BASE_RELAYER_PRIVATE_KEY not set -- Base chain routes will return 503");
}

const POOL_ADDRESS = process.env.BASE_POOL_ADDRESS as `0x${string}` | undefined;
const SHETH_ADDRESS = process.env.BASE_SHETH_ADDRESS as `0x${string}` | undefined;

const IS_MAINNET = process.env.BASE_NETWORK === "mainnet";
const chain = IS_MAINNET ? base : baseSepolia;

// Primary: BASE_RPC_URL (Alchemy). Fallback: public Base RPC if Alchemy fails.
const BASE_PUBLIC_RPC = "https://mainnet.base.org";
const SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const BASE_RPC_URL = process.env.BASE_RPC_URL;

function makeTransport(isMainnet: boolean) {
  if (isMainnet && BASE_RPC_URL) {
    return fallback([http(BASE_RPC_URL), http(BASE_PUBLIC_RPC)]);
  }
  return http(isMainnet ? BASE_PUBLIC_RPC : SEPOLIA_RPC);
}

export const basePublicClient = createPublicClient({
  chain,
  transport: makeTransport(IS_MAINNET),
});

export function getBaseWalletClient() {
  if (!RAW_KEY) throw new Error("BASE_RELAYER_PRIVATE_KEY not set");
  const key = (RAW_KEY.startsWith("0x") ? RAW_KEY : `0x${RAW_KEY}`) as `0x${string}`;
  const account = privateKeyToAccount(key);
  return {
    client: createWalletClient({ account, chain, transport: makeTransport(IS_MAINNET) }),
    account,
  };
}

export function getPoolAddress(): `0x${string}` {
  if (!POOL_ADDRESS) throw new Error("BASE_POOL_ADDRESS not set");
  return POOL_ADDRESS;
}

export function getShETHAddress(): `0x${string}` {
  if (!SHETH_ADDRESS) throw new Error("BASE_SHETH_ADDRESS not set");
  return SHETH_ADDRESS;
}

export function isBaseEnabled(): boolean {
  return !!(RAW_KEY && POOL_ADDRESS && SHETH_ADDRESS);
}

export function getRelayerAddress(): string {
  if (!RAW_KEY) return "";
  const key = (RAW_KEY.startsWith("0x") ? RAW_KEY : `0x${RAW_KEY}`) as `0x${string}`;
  return privateKeyToAccount(key).address;
}

export const POOL_ABI = [
  {
    name: "shield",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "stokenAddress", type: "address" },
      { name: "initialOtsHash", type: "bytes32" },
      { name: "chainDepth", type: "uint8" },
    ],
    outputs: [],
  },
  {
    name: "shieldWithDecoys",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "stokenAddress", type: "address" },
      { name: "initialOtsHash", type: "bytes32" },
      { name: "chainDepth", type: "uint8" },
      { name: "allAccounts", type: "address[]" },
    ],
    outputs: [],
  },
  {
    name: "batchAdminMint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "stokenAddresses", type: "address[]" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "burnAndQueue",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "otsPreimage", type: "bytes32" },
      { name: "allBurnAccounts", type: "address[]" },
    ],
    outputs: [],
  },
  {
    name: "processQueue",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "refreshOts",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "stokenAddress", type: "address" },
      { name: "otsPreimage", type: "bytes32" },
      { name: "newOtsHash", type: "bytes32" },
      { name: "newChainDepth", type: "uint8" },
    ],
    outputs: [],
  },
  {
    name: "getUserState",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "stokenAddress", type: "address" }],
    outputs: [
      { name: "currentOtsHash", type: "bytes32" },
      { name: "chainDepth", type: "uint8" },
      { name: "deposited", type: "uint256" },
      { name: "initialized", type: "bool" },
    ],
  },
  {
    name: "getPoolBalance",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "relayer",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const SHETH_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
