import { withTimeout } from './timeout.ts';
import { createKcc20PsktBuilderEngine } from '@kaspacom/kcc20-tx-builder/engine';
import { buildKcc20DeployTokenOperation } from '@kaspacom/kcc20-tx-builder/deploy-operation';
import { buildKcc20TransferTokenOperation } from '@kaspacom/kcc20-tx-builder/token-operation';
import { assertKcc20ArtifactScriptHash, isKcc20ArtifactKey } from '@kaspacom/kcc20-tx-builder/artifacts';
import type { Kcc20IndexedCovenantUtxo } from '@kaspacom/kcc20-tx-builder/action-source-resolver';
import type * as Wasm from '../vendor/kaspa/kaspa.js';

export const network = 'testnet-10';
export type Runtime = typeof Wasm;
export type Wallet = { walletAddress: string; kcc20Owner: string };
export type Operation = ReturnType<typeof buildKcc20DeployTokenOperation>;
export type Sources = { getUtxosByAddresses(args: { addresses: string[] }): Promise<unknown> };
export type Built = { psktTransactionJson: string; signInputs: { index: number; sighashType: number }[]; scripts?: unknown[]; metadata: Record<string, any>; submitTransactionSupported: boolean };

// This is application wiring, not a second SDK API.
export function engineInput(operation: Operation) {
  const p = operation.payload;
  if (p.network !== network) throw new Error('These examples require testnet-10');
  if (!p.owner.walletAddress.startsWith('kaspatest:')) throw new Error('Expected a testnet wallet address');
  return {
    schema: 'kcc20-in-process-pskt-builder-input/v1', schemaVersion: 1,
    builder: { builderKey: p.signing.builderKey, operation: p.operation, contract: p.contract, action: p.action, requiredSources: p.sourceRequirements },
    request: { builderKey: p.signing.builderKey, operation: p.operation, contract: p.contract, action: p.action, network: p.network, params: p.params, owner: p.owner, requiredSources: p.sourceRequirements, sourceRequirements: p.sourceRequirements, signerRequirements: p.signerRequirements },
  };
}

export function createBuilder(wasm: Runtime, sources: Sources, loadArtifact: (key: string) => Promise<unknown>) {
  for (const key of ['Transaction', 'GenesisCovenantGroup', 'TransactionOutput', 'payToScriptHashScript'] as const) {
    if (typeof wasm[key] !== 'function') throw new Error(`Incompatible WASM runtime: missing ${key}`);
  }
  const engine = createKcc20PsktBuilderEngine({ wasm, artifacts: {}, sourceProvider: { getUtxosByAddresses: args => withTimeout(sources.getUtxosByAddresses(args), "UTXO query") },
    config: { KASPA_NETWORK: network },
    artifactProvider: async key => {
      if (!isKcc20ArtifactKey(key)) throw new Error(`Unsupported artifact: ${key}`);
      const artifact = await loadArtifact(key);
      assertKcc20ArtifactScriptHash(key, artifact);
      return artifact;
    },
  });
  return async (operation: Operation): Promise<Built> => {
    const result = await engine.build(engineInput(operation));
    if (typeof result.psktTransactionJson !== 'string' || !Array.isArray(result.signInputs)) throw new Error('Invalid builder output');
    return result as Built;
  };
}

export function deployOperation(wallet: Wallet) {
  return buildKcc20DeployTokenOperation(wallet, {
    ticker: 'DEMO', tokenName: 'Example token', decimals: 2,
    maxSupply: '1000', premintSupply: '1000', mintPolicy: 'fixed', mintPricePerTokenSompi: '0',
  }, { network, requestId: 'example-deploy', createdAt: '2026-01-01T00:00:00.000Z' });
}

export function transferOperation(wallet: Wallet, holder: Kcc20IndexedCovenantUtxo, recipientOwner: string, tokenAmount = '12.50') {
  if (!holder.covenantId) throw new Error('A native covenant ID is required');
  return buildKcc20TransferTokenOperation(wallet, {
    token: { covenantId: holder.covenantId, ticker: 'DEMO', decimals: 2 },
    activeUtxos: [holder], recipientOwner, tokenAmount,
  }, { network, requestId: 'example-transfer', createdAt: '2026-01-01T00:00:00.000Z' });
}

export function inspect(result: Built) {
  const tx = JSON.parse(result.psktTransactionJson);
  const inputSompi = tx.inputs.reduce((n: bigint, input: any) => n + BigInt(input.utxo.amount), 0n);
  const outputSompi = tx.outputs.reduce((n: bigint, output: any) => n + BigInt(output.value), 0n);
  return { operation: result.metadata.builderKey, network: result.metadata.network, inputs: tx.inputs.length, outputs: tx.outputs.length, feeSompi: (inputSompi - outputSompi).toString(), signInputs: result.signInputs, intent: result.metadata.intentOutputs?.map(({ revealScriptHex, ...intent }: any) => intent) ?? null };
}
