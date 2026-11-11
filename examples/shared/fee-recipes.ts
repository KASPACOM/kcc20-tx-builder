import { isKcc20BuilderKey } from '@kaspacom/kcc20-tx-builder/operations';
import { validateRequest, type LifecycleRequest } from './lifecycle.ts';

// Parameter names match the published engine. Values are decoded public state or
// caller choices; the engine revalidates scripts, outpoints, policy and ownership.
export const feeRecipes = {
  'create-account': ['tokenId', 'principalSompi'],
  'bind-account': ['tokenId', 'accountId', 'marketId', 'policyId', 'accountGenesisHint'],
  'deploy-market-genesis': ['canonicalCovenantId', 'feeTicketId', 'priceScale', 'feePolicy', 'policyId', 'tokenUtxo', 'protocolAccount', 'wrapperPrincipalSompi'],
  'bind-market': ['contractCanonicalTokenId', 'marketId', 'policyId', 'feePolicy', 'feeTicketId', 'priceScale', 'wrapperGenesisHint', 'wrapperProfile', 'rootPrincipalSompi'],
  wrap: ['tokenUtxo', 'wrapperUtxo', 'tokenAmount', 'recipientOwner'],
  unwrap: ['wrappedUtxo', 'wrapperUtxo', 'reserveUtxo', 'tokenAmount', 'recipientOwner'],
  'merge-holders': ['holderUtxos'],
  'create-ask': ['holderUtxo', 'askAmount', 'askUnitPriceSompi'],
  'cancel-ask': ['askUtxo'],
  'create-bid': ['rootUtxo', 'bidAmount', 'bidUnitPriceSompi'],
  'cancel-bid': ['bidUtxo'],
  'buy-ask': ['askUtxo', 'fillAmount', 'sellerPayoutAddress'],
  'buy-two-asks': ['asks'],
  'sell-into-bids': ['holderUtxo', 'bids'],
  claim: ['party', 'account', 'receipts', 'protocolAccountId', 'creatorAccountId'],
  'rotate-account': ['account', 'accountId', 'newOwner', 'newOwnerScheme'],
  'create-recipient': ['tokenId', 'principalSompi', 'marketId', 'policyId'],
} as const;
export type FeeRecipe = keyof typeof feeRecipes;
export type FeeRecipeConfig = {
  owner: LifecycleRequest['request']['owner'];
  common?: Record<string, unknown>;
  params: Record<string, unknown>;
};
export function feeRequest(recipe: string, config: FeeRecipeConfig): LifecycleRequest {
  if (!Object.hasOwn(feeRecipes, recipe) || !isKcc20BuilderKey(`kcc20fee.${recipe}`))
    throw new Error('Unknown fee recipe');
  const params = normalizeFeeSources({ ...config.common, ...config.params }) as Record<string, unknown>;
  for (const field of feeRecipes[recipe as FeeRecipe]) {
    if (params[field] === undefined || params[field] === null) throw new Error(`Missing ${recipe} parameter: ${field}`);
  }
  const request: LifecycleRequest = { schema: 'kcc20-in-process-pskt-builder-input/v1', request: {
    builderKey: `kcc20fee.${recipe}`, network: 'testnet-10', owner: config.owner, params,
  } };
  validateRequest(request);
  return request;
}

// Public snapshot rows use amountSompi; fee builders require amountSompiExact.
// Preserve supplied exact values. Never stringify an already-rounded JS number.
export function normalizeFeeSources(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeFeeSources);
  if (!value || typeof value !== 'object') return value;
  const row = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeFeeSources(item)]));
  if (typeof row.txidHex === 'string' && typeof row.address === 'string' && row.vout !== undefined && row.amountSompiExact === undefined) {
    const amount = row.amountSompi;
    if (typeof amount === 'string' && /^[0-9]+$/.test(amount)) row.amountSompiExact = amount;
    else if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) row.amountSompiExact = String(amount);
    else throw new Error('Source UTXO requires an exact integer KAS amount');
  }
  return row;
}
