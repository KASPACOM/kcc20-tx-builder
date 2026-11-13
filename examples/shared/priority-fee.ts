import { validateNetworkFeeQuote, type NetworkFeeQuote } from '@kaspacom/kcc20-tx-builder/network-fee';
import { withTimeout } from './timeout.ts';
export async function nodePriorityQuote(
  rpc: { getFeeEstimate(): Promise<{ estimate: { priorityBucket: { feerate: number } } }> },
): Promise<NetworkFeeQuote> {
  const observedAtMs = Date.now();
  const response = await withTimeout(rpc.getFeeEstimate(), 'Priority fee estimate');
  const quote: NetworkFeeQuote = { network: 'testnet-10', source: 'connected-tn10-node',
    observedAtMs, tier: 'priority', sompiPerNormalizedMass: String(response.estimate.priorityBucket.feerate) };
  validateNetworkFeeQuote(quote, 'testnet-10');
  return quote;
}
