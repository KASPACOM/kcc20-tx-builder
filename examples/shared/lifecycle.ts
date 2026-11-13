import type { NetworkFeeQuote } from '@kaspacom/kcc20-tx-builder/network-fee';
import { createKcc20PsktBuilderEngine } from '@kaspacom/kcc20-tx-builder/engine';
import { isKcc20BuilderKey } from '@kaspacom/kcc20-tx-builder/operations';
import { assertKcc20ArtifactScriptHash, isKcc20ArtifactKey } from '@kaspacom/kcc20-tx-builder/artifacts';
import type { Built, Runtime } from './build.ts';
import { attachScripts, signingInputs } from './signing.ts';
import { withTimeout } from './timeout.ts';

export const network = 'testnet-10';
export type LifecycleRequest = {
  schema: 'kcc20-in-process-pskt-builder-input/v1';
  request: { builderKey: string; network: typeof network;
    owner: { walletAddress: string; kcc20Owner: string; publicKey?: string };
    params: Record<string, unknown> };
};
export function validateRequest(value: unknown): asserts value is LifecycleRequest {
  const v = value as LifecycleRequest;
  if (v?.schema !== 'kcc20-in-process-pskt-builder-input/v1' || v.request?.network !== network)
    throw new Error('Expected a DEV testnet-10 builder request');
  const key = v.request.builderKey;
  if (!isKcc20BuilderKey(key) || !/^(kcc20\.|kcc20fee\.|fee-ticket\.)/.test(key))
    throw new Error('Unsupported public lifecycle operation');
  if (!v.request.owner?.walletAddress?.startsWith('kaspatest:') ||
      !/^[0-9a-f]{64}$/i.test(v.request.owner?.kcc20Owner ?? '') ||
      !v.request.params || Array.isArray(v.request.params) || typeof v.request.params !== 'object')
    throw new Error('Request requires wallet identity and operation parameters');
}
export type Source = { getUtxosByAddresses(args: { addresses: string[] }): Promise<unknown> };
export type Signer = {
  capabilities: { schnorr: boolean; ecdsa: boolean };
  sign(unsigned: string, inputs: ReturnType<typeof signingInputs>): Promise<string>;
};

// One host-owned node connection; the package owns all construction and fee rules.
export type FeeOptions = { networkFeeQuote?: NetworkFeeQuote; networkFeeQuoteProvider?: (network: string) => Promise<NetworkFeeQuote> };
export function lifecycleBuilder(wasm: Runtime, source: Source,
  loadArtifact: (key: string) => Promise<unknown>, capabilities = { schnorr: true, ecdsa: false }, fees: FeeOptions = {}) {
  let building = false;
  const observed = new Map<string, string>();
  const lineages = new WeakMap<Built, Map<string, string>>();
  const engine = createKcc20PsktBuilderEngine({ wasm, artifacts: {}, ...fees,
    sourceProvider: { async getUtxosByAddresses(args) {
      const response = await withTimeout(source.getUtxosByAddresses(args), 'Fresh UTXOs') as { entries: any[] };
      for (const entry of response.entries) {
        const live = entry.entry ?? entry.utxoEntry ?? entry;
        observed.set(`${entry.outpoint.transactionId}:${entry.outpoint.index}`, live.covenantId?.toString() ?? entry.covenantId?.toString() ?? '');
      }
      return response;
    } },
    config: { KASPA_NETWORK: network }, walletSigningCapabilities: capabilities,
    artifactProvider: async key => {
      if (!isKcc20ArtifactKey(key)) throw new Error('Unknown artifact');
      const artifact = await loadArtifact(key);
      assertKcc20ArtifactScriptHash(key, artifact);
      return artifact;
    },
  });
  return {
    async build(request: unknown): Promise<Built> {
      validateRequest(request);
      if (building) throw new Error('Wait for the current build before starting another');
      building = true;
      observed.clear();
      try {
      const built = await engine.build(request) as unknown as Built;
      if (typeof built.psktTransactionJson !== 'string' || !Array.isArray(built.signInputs))
        throw new Error('Invalid builder response');
      const expected = new Map<string, string>();
      for (const input of JSON.parse(built.psktTransactionJson).inputs) {
        const id = `${input.transactionId}:${input.index}`;
        if (!observed.has(id)) throw new Error('Input was not observed from the node');
        expected.set(id, observed.get(id)!);
      }
      lineages.set(built, expected);
      return built;
      } finally { observed.clear(); building = false; }
    },
    async assertFresh(built: Built) { await assertFreshInputs(wasm, source, built, lineages.get(built)); },
    async sign(built: Built, signer: Signer) {
      await assertFreshInputs(wasm, source, built, lineages.get(built));
      const raw = await signer.sign(built.psktTransactionJson, signingInputs(built, signer.capabilities));
      // Reject changed intent and missing signatures before attaching covenant arguments.
      const signed = attachScripts(wasm, raw, built, signer.capabilities);
      const tx = wasm.Transaction.deserializeFromSafeJSON(signed);
      if (built.networkFee) engine.verifySignedNetworkFee(signed, built.networkFee.quote);
      engine.protocol.assertTransactionComputeMassStandard(tx, 'public lifecycle');
      engine.protocol.assertTransactionStorageMassStandard(tx, 'public lifecycle');
      const mass = engine.protocol.calculateToccataV1NonContextualMass(tx, 'public lifecycle');
      const storageMass = engine.protocol.calculateToccataStorageMass(tx, 'public lifecycle');
      return { transaction: tx, signed, mass: { ...mass, storageMass } };
    },
  };
}

export function walletDebit(wasm: Runtime, built: Built, address: string): bigint {
  const tx = wasm.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const script = wasm.payToAddressScript(address);
  const same = (s: { version: number; script: string }) =>
    s.version === script.version && s.script === script.script;
  const inputs = tx.inputs.reduce((n, i) => n + (i.utxo && same(i.utxo.scriptPublicKey) ? i.utxo.amount : 0n), 0n);
  const outputs = tx.outputs.reduce((n, o) => n + (same(o.scriptPublicKey) ? o.value : 0n), 0n);
  return inputs - outputs;
}

export async function accepted(rest: string, transactionId: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(transactionId)) throw new Error('Invalid transaction ID');
  const url = new URL(`transactions/${transactionId}`, rest.replace(/\/?$/, '/'));
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Acceptance source HTTP ${response.status}`);
  const body = await response.json();
  return body.transaction_id === transactionId && body.is_accepted === true;
}

export async function assertFreshInputs(wasm: Runtime, source: Source, built: Built, lineages?: Map<string, string>) {
  if (!lineages) throw new Error('Build again before signing or broadcasting');
  const tx = wasm.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const addresses = [...new Set(tx.inputs.map(input => {
    if (!input.utxo) throw new Error('Missing input UTXO');
    const address = wasm.addressFromScriptPublicKey(input.utxo.scriptPublicKey, network);
    if (!address) throw new Error('Input script has no address');
    return address.toString();
  }))];
  const response = await withTimeout(source.getUtxosByAddresses({ addresses }), 'Pre-sign UTXOs') as { entries: any[] };
  if (!Array.isArray(response.entries)) throw new Error('Missing node UTXOs');
  for (const [index, input] of tx.inputs.entries()) {
    const entry = response.entries.find(e => e.outpoint?.transactionId === input.previousOutpoint.transactionId && e.outpoint?.index === input.previousOutpoint.index);
    const live = entry?.entry ?? entry?.utxoEntry ?? entry;
    if (!live || BigInt(live.amount) !== input.utxo!.amount) throw new Error('Input spent or amount changed; rebuild');
    const script = typeof live.scriptPublicKey === 'string'
      ? new wasm.ScriptPublicKey(parseInt(live.scriptPublicKey.slice(0, 4).match(/../g)!.reverse().join(''), 16), live.scriptPublicKey.slice(4))
      : live.scriptPublicKey;
    if (script.version !== input.utxo!.scriptPublicKey.version || script.script !== input.utxo!.scriptPublicKey.script ||
        (live.covenantId?.toString() ?? entry.covenantId?.toString() ?? '') !== lineages.get(`${input.previousOutpoint.transactionId}:${input.previousOutpoint.index}`)) throw new Error('Input script or lineage changed; rebuild');
  }
}

export async function resumeAcceptance(
  rest: string,
  record: { network?: unknown; transactionId?: unknown; broadcastTransactionId?: unknown },
  lookup: (rest: string, id: string) => Promise<boolean> = accepted,
) {
  if (record.network !== network || !record.transactionId) throw new Error('Evidence has no TN10 transaction');
  const candidates = [record.transactionId, record.broadcastTransactionId].filter(value => value !== undefined);
  if (candidates.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)))
    throw new Error('Evidence contains an invalid transaction ID');
  const ids = [...new Set((candidates as string[]).map(id => id.toLowerCase()))];
  const observations = await Promise.all(ids.map(async transactionId => ({ transactionId, accepted: await lookup(rest, transactionId) })));
  return { observations, requiresReconciliation: ids.length > 1, indexed: 'not checked' };
}
