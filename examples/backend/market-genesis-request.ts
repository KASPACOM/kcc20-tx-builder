import { readFile } from 'node:fs/promises';
import { prepareKcc20FeeMarketGenesis, templateParts } from '@kaspacom/kcc20-tx-builder';
import { loadArtifact } from './runtime.ts';
import { feeRequest } from '../shared/fee-recipes.ts';
try {
  if (!process.argv[2]) throw new Error('Usage: npm run --silent market-genesis-request -- config.json');
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const names = { receipt: 'KCC20FeeEscrowV1', root: 'KCC20OrderbookFeeRootV1',
    holder: 'KCC20OrderbookFeeHolderV1', ask: 'KCC20OrderbookFeeAskV1', bid: 'KCC20OrderbookFeeBidV1',
    ticket: 'KCC20FeeTicket', wrapper: 'KCC20WrapperFeeV2', argentWrapper: 'KCC20WrapperFeeArgentV2' };
  const artifacts: any = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([role, name]) => [role, await loadArtifact(`${name}.placeholder.json`)])));
  const policy: Parameters<typeof prepareKcc20FeeMarketGenesis>[0]["policy"] = { version: 1, creatorFeeBps: config.creatorFeeBps,
    protocolAccountId: config.protocolAccount.accountId,
    creatorAccountId: config.creatorFeeBps ? config.creatorAccount.accountId : '00'.repeat(32),
    ...Object.fromEntries(['receipt', 'root', 'holder', 'ask', 'bid', 'ticket'].map(role => {
      const t = templateParts(artifacts[role]);
      return [`${role}Template`, { hash: Buffer.from(t.hash).toString('hex'), prefixLength: t.prefixLength, suffixLength: t.suffixLength }];
    })) } as Parameters<typeof prepareKcc20FeeMarketGenesis>[0]['policy'];
  const genesis = prepareKcc20FeeMarketGenesis({ tokenId: config.canonicalCovenantId,
    feeTicketId: config.feeTicketId, priceScale: BigInt(config.priceScale),
    policy, wrapperProfile: 'native', artifacts });
  console.log(JSON.stringify(feeRequest('deploy-market-genesis', { owner: config.owner, params: {
    canonicalCovenantId: config.canonicalCovenantId, feeTicketId: config.feeTicketId,
    priceScale: config.priceScale, wrapperVersion: 2, wrapperPrincipalSompi: config.wrapperPrincipalSompi,
    feePolicy: policy, policyId: genesis.policyId, tokenUtxo: config.tokenUtxo,
    protocolAccount: config.protocolAccount, creatorAccount: config.creatorAccount,
  } }), null, 2));
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
