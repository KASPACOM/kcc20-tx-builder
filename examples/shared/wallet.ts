// Small host example using existing routes. This is not a new SDK or API.
export type BalanceRow = {
  canonicalCovenantId: string;
  token: { name?: string | null; ticker?: string | null; decimals?: number | null };
  nativeBalance: { amount: string; transferable: boolean };
  wrappedBalance: { amount: string; wrappedMarketId: string | null; transferable: boolean };
};
export type BalancePage = { items: BalanceRow[]; total: number; limit: number; offset: number; generatedAtMs: number };
export type Freshness = { ok: boolean; stale: boolean; suggestedPollMs: number };
export function formatQuantity(amount: string, decimals: number | null | undefined): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new Error('Invalid base-unit quantity');
  if (decimals == null) return `${amount} base units`;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error('Invalid token decimals');
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
export function transferReady(health: { ok?: boolean }, freshness: Freshness): boolean {
  return health.ok === true && freshness.ok === true && freshness.stale === false;
}
export function walletClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Expected HTTP API URL');
  const request = async <T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> => {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Wallet API HTTP ${response.status}`);
    return response.json() as Promise<T>;
  };
  return {
    health: () => request<{ ok: boolean }>('/health'),
    freshness: () => request<Freshness>('/trading/freshness'),
    directory: () => request<unknown>('/wallet-provider/tokens'),
    // One page per user request; do not repeatedly download the whole wallet.
    balances: (owner: string, query: Record<string, string | number | boolean | undefined> = {}) =>
      request<BalancePage>(`/wallet-provider/owners/${encodeURIComponent(owner)}/balances`, { limit: 100, offset: 0, hasBalance: true, ...query }),
    settlement: (txid: string) => {
      if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('Invalid transaction ID');
      return request<{ indexed?: boolean; decoded?: boolean; actionCount: number }>(`/trading/tx/${txid}/settlement-status`);
    },
  };
}
