import { createKcc20PsktBuilderEngine } from '@kaspacom/kcc20-tx-builder/engine';
import { assertKcc20ArtifactScriptHash, isKcc20ArtifactKey } from '@kaspacom/kcc20-tx-builder/artifacts';
import type { Built, Runtime, Wallet } from './build.ts';
import { withTimeout } from './timeout.ts';

// These are existing package request fields, not an API response schema.
// Obtain fixed policy from the active market and current decoded UTXOs from
// /trading/covenants/{covenantId}/utxos. Never synthesize policy from display data.
export type WrapRequest = {
  operation: 'wrap' | 'unwrap'; wallet: Wallet;
  params: Record<string, unknown> & {
    wrapperVersion: 2; marketId: string; contractCanonicalTokenId: string;
    feeTicketId: string; priceScale: string; tokenAmount: string;
    feePolicy: unknown; policyId: string; wrapperUtxo: unknown;
  };
};
export async function buildWrap(wasm: Runtime, rpc: InstanceType<Runtime['RpcClient']>,
  loadArtifact: (key: string) => Promise<unknown>, input: WrapRequest): Promise<Built> {
  if (!['wrap', 'unwrap'].includes(input.operation) || input.params.wrapperVersion !== 2)
    throw new Error('Expected current native fee-market wrap/unwrap');
  if ((await withTimeout(rpc.getBlockDagInfo(), 'Network check')).network !== 'testnet-10')
    throw new Error('Wallet example requires testnet-10');
  const engine = createKcc20PsktBuilderEngine({ wasm, artifacts: {},
    config: { KASPA_NETWORK: 'testnet-10' },
    sourceProvider: { getUtxosByAddresses: args => withTimeout(rpc.getUtxosByAddresses(args), 'Current UTXOs') },
    artifactProvider: async key => {
      if (!isKcc20ArtifactKey(key)) throw new Error('Unknown artifact');
      const artifact = await loadArtifact(key); assertKcc20ArtifactScriptHash(key, artifact); return artifact;
    },
  });
  return await engine.build({ schema: 'kcc20-in-process-pskt-builder-input/v1', request: {
    builderKey: `kcc20fee.${input.operation}`, network: 'testnet-10', owner: input.wallet, params: input.params,
  } }) as unknown as Built;
}
