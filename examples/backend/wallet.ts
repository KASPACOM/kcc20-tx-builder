import { walletClient, walletBalanceView, transferReady } from '../shared/wallet.ts';
const owner = process.argv[2];
if (!owner) throw new Error('Usage: npm run wallet -- <testnet-address-or-owner>');
const client = walletClient(process.env.KCC20_API_URL ?? 'https://dev-api-kcc20.kaspa.com');
const [health, freshness, page] = await Promise.all([client.health(), client.freshness(), client.balances(owner)]);
console.log(JSON.stringify({ transferReady: transferReady(health, freshness), freshness,
  total: page.total, offset: page.offset, limit: page.limit,
  coverage: page.coverage ?? null,
  unresolvedTotal: page.unresolvedTotal ?? null,
  ...walletBalanceView(page),
}, null, 2));
