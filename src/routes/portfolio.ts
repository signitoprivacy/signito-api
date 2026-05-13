import { Router, type IRouter } from "express";
import { heliusRpcUrl } from "../lib/rpc";

const router: IRouter = Router();

// Classic SPL Token program
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// SPL Token-2022 program (used for NonTransferable sTokens)
const SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const KNOWN_TOKENS: Record<string, { name: string; symbol: string }> = {
  native: { name: "SOL", symbol: "SOL" },
  So11111111111111111111111111111111111111112: { name: "SOL", symbol: "SOL" },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { name: "USD Coin", symbol: "USDC" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { name: "Tether USD", symbol: "USDT" },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { name: "Bonk", symbol: "BONK" },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { name: "dogwifhat", symbol: "WIF" },
  jtojtomepa8bdiya96v9tkrccjt9d9smf9j8kvf9p: { name: "Jito", symbol: "JTO" },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm39: { name: "Marinade SOL", symbol: "mSOL" },
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": { name: "Lido Staked SOL", symbol: "stSOL" },
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: { name: "BlazeStake SOL", symbol: "bSOL" },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { name: "Jupiter", symbol: "JUP" },
};

interface TokenAccountInfo {
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
          state?: string;
        };
        type?: string;
      };
    };
    owner: string;
  };
}

type TokenAccountsResponse = {
  result?: { value?: TokenAccountInfo[] };
  error?: { message: string };
};

function resolveToken(mint: string): { name: string; symbol: string } {
  const known = KNOWN_TOKENS[mint];
  if (known) return known;
  const short = mint.slice(0, 4) + ".." + mint.slice(-4);
  return { name: short, symbol: short };
}

router.get("/portfolio/:wallet", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.wallet) ? req.params.wallet[0] : req.params.wallet;
  const wallet = raw as string;
  const heliusKey = process.env.HELIUS_API_KEY;

  if (!heliusKey) {
    res.json({ wallet, solBalance: 0, tokens: [] });
    return;
  }

  const rpcUrl = heliusRpcUrl();

  try {
    const [balanceRes, splRes, spl2022Res] = await Promise.all([
      // Native SOL balance
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "getBalance",
          params: [wallet],
          id: 1,
        }),
        signal: AbortSignal.timeout(10000),
      }),
      // Classic SPL Token accounts
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "getTokenAccountsByOwner",
          params: [wallet, { programId: SPL_TOKEN_PROGRAM }, { encoding: "jsonParsed" }],
          id: 2,
        }),
        signal: AbortSignal.timeout(10000),
      }),
      // Token-2022 accounts (sSOL, sUSDC, aSOL, etc.)
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "getTokenAccountsByOwner",
          params: [wallet, { programId: SPL_TOKEN_2022_PROGRAM }, { encoding: "jsonParsed" }],
          id: 3,
        }),
        signal: AbortSignal.timeout(10000),
      }),
    ]);

    const balanceData = (await balanceRes.json()) as {
      result?: { value?: number };
      error?: { message: string };
    };

    const splData = (await splRes.json()) as TokenAccountsResponse;
    const spl2022Data = (await spl2022Res.json()) as TokenAccountsResponse;

    const lamports = balanceData.result?.value ?? 0;
    const solBalance = lamports / 1_000_000_000;

    const allAccounts = [
      ...(splData.result?.value ?? []),
      ...(spl2022Data.result?.value ?? []),
    ];

    const tokens = allAccounts
      .map((account) => {
        const info = account.account.data.parsed.info;
        const uiAmount = info.tokenAmount.uiAmount ?? 0;
        // Skip zero-balance accounts
        if (uiAmount === 0 && info.tokenAmount.amount === "0") return null;
        const { name, symbol } = resolveToken(info.mint);
        const is2022 = account.account.owner === SPL_TOKEN_2022_PROGRAM;
        return {
          mint: info.mint,
          name,
          symbol,
          amount: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
          uiAmount,
          program: is2022 ? "token-2022" : "token",
        };
      })
      .filter(Boolean);

    res.json({ wallet, solBalance, tokens });
  } catch (err) {
    req.log.error({ err }, "Portfolio fetch error");
    res.json({ wallet, solBalance: 0, tokens: [] });
  }
});

export default router;
