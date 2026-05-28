let cachedPrice: number | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 3 * 60 * 1000;

export async function getSolPriceUsd(): Promise<number | null> {
  if (cachedPrice !== null && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedPrice;
  }
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return cachedPrice;
    const data = (await res.json()) as { solana?: { usd?: number } };
    const price = data?.solana?.usd ?? null;
    if (price !== null && price > 0) {
      cachedPrice = price;
      cachedAt = Date.now();
    }
    return cachedPrice;
  } catch {
    return cachedPrice;
  }
}
