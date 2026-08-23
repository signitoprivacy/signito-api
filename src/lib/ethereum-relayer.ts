import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { logger } from "./logger.js";

const RAW_KEY = process.env.ETH_RELAYER_PRIVATE_KEY;
const POOL_ADDRESS = process.env.ETHEREUM_POOL_ADDRESS as `0x${string}` | undefined;
const SHETH_ADDRESS = process.env.ETHEREUM_SHETH_ADDRESS as `0x${string}` | undefined;
const ETHEREUM_PUBLIC_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://1rpc.io/eth",
];
const ETHEREUM_RPC_URL = process.env.ETHEREUM_MAINNET_RPC_URL;
const ETHEREUM_RPC_FALLBACK_URL = process.env.ETHEREUM_MAINNET_RPC_FALLBACK_URL;
const ETHEREUM_RECEIPT_POLL_INTERVAL_MS = 60_000;

if (!RAW_KEY) {
  logger.warn("ETH_RELAYER_PRIVATE_KEY not set -- Ethereum routes will return 503");
}

function makeTransport() {
  const urls = [ETHEREUM_RPC_URL, ETHEREUM_RPC_FALLBACK_URL, ...ETHEREUM_PUBLIC_RPCS]
    .filter((url): url is string => Boolean(url))
    .filter((url, index, all) => all.indexOf(url) === index);
  return fallback(
    urls.map((url) => http(url, { retryCount: 1, retryDelay: 300 })),
    { retryCount: 2, retryDelay: 250 },
  );
}

export const ethereumPublicClient = createPublicClient({
  chain: mainnet,
  transport: makeTransport(),
});

export async function withEthereumRpcRetry<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function waitForEthereumReceipt(hash: `0x${string}`) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await ethereumPublicClient.getTransactionReceipt({ hash });
    } catch (error) {
      logger.info(
        { hash, attempt, nextPollMs: ETHEREUM_RECEIPT_POLL_INTERVAL_MS, error },
        "Ethereum transaction is pending; receipt status will be checked again",
      );
      await new Promise((resolve) => setTimeout(resolve, ETHEREUM_RECEIPT_POLL_INTERVAL_MS));
    }
  }
}

export function getEthereumWalletClient() {
  if (!RAW_KEY) throw new Error("ETH_RELAYER_PRIVATE_KEY not set");
  const key = (RAW_KEY.startsWith("0x") ? RAW_KEY : `0x${RAW_KEY}`) as `0x${string}`;
  const account = privateKeyToAccount(key);
  return {
    client: createWalletClient({ account, chain: mainnet, transport: makeTransport() }),
    account,
  };
}

export function getEthereumPoolAddress(): `0x${string}` {
  if (!POOL_ADDRESS) throw new Error("ETHEREUM_POOL_ADDRESS not set");
  return POOL_ADDRESS;
}

export function getEthereumShETHAddress(): `0x${string}` {
  if (!SHETH_ADDRESS) throw new Error("ETHEREUM_SHETH_ADDRESS not set");
  return SHETH_ADDRESS;
}

export function getEthereumRelayerAddress(): string {
  if (!RAW_KEY) return "";
  const key = (RAW_KEY.startsWith("0x") ? RAW_KEY : `0x${RAW_KEY}`) as `0x${string}`;
  return privateKeyToAccount(key).address;
}

export function isEthereumEnabled(): boolean {
  return Boolean(RAW_KEY && POOL_ADDRESS && SHETH_ADDRESS);
}

export const ETHEREUM_POOL_ABI = [
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
] as const;

export const ETHEREUM_SHETH_ABI = [
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