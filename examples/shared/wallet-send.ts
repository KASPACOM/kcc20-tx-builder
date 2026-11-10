import { createKcc20PsktBuilderEngine } from '@kaspacom/kcc20-tx-builder/engine';
import { buildKcc20TransferTokenOperation } from '@kaspacom/kcc20-tx-builder/token-operation';
import type { Kcc20IndexedCovenantUtxo } from '@kaspacom/kcc20-tx-builder/action-source-resolver';
import { createBuilder, type Runtime, type Wallet, type Built } from './build.ts';
import { attachScripts, signingInputs } from './signing.ts';
import { withTimeout } from './timeout.ts';

export type SendRequest = { wallet: Wallet; covenantId: string;
  recipient: string; quantityBaseUnits: string; holders: Kcc20IndexedCovenantUtxo[] };
export type WalletSigner = (unsigned: string, inputs: ReturnType<typeof signingInputs>) => Promise<string>;

// Both browser and Node callers supply one connected RPC and their own signer.
// Building never signs or broadcasts. RPC-backed construction verifies source scripts.
export async function buildSend(wasm: Runtime, rpc: InstanceType<Runtime['RpcClient']>,
  artifacts: (key: string) => Promise<unknown>, request: SendRequest): Promise<Built> {
  if ((await withTimeout(rpc.getBlockDagInfo(), 'Network check')).network !== 'testnet-10')
    throw new Error('Wallet example requires testnet-10');
  if (!request.wallet.walletAddress.startsWith('kaspatest:') ||
      (request.recipient.includes(':') && !request.recipient.startsWith('kaspatest:')))
    throw new Error('Wallet and recipient must use testnet addresses');
  if (!/^[1-9][0-9]*$/.test(request.quantityBaseUnits))
    throw new Error('Send amount must be positive integer base units');
  const operation = buildKcc20TransferTokenOperation(request.wallet, {
    token: { covenantId: request.covenantId, decimals: 0 },
    activeUtxos: request.holders, recipientOwner: request.recipient, tokenAmount: request.quantityBaseUnits,
  }, { network: 'testnet-10' });
  return createBuilder(wasm, rpc, artifacts)(operation);
}

export async function signSend(wasm: Runtime, rpc: InstanceType<Runtime['RpcClient']>, built: Built, signer: WalletSigner): Promise<string> {
  await assertCurrentInputs(wasm, rpc, built.psktTransactionJson);
  const raw = await signer(built.psktTransactionJson, signingInputs(built));
  // Reject a signer that changes destinations, quantities, inputs or fees.
  return attachScripts(wasm, raw, built);
}

export async function assertCurrentInputs(wasm: Runtime, rpc: InstanceType<Runtime['RpcClient']>, json: string) {
  if ((await withTimeout(rpc.getBlockDagInfo(), 'Network check')).network !== 'testnet-10')
    throw new Error('Wallet example requires testnet-10');
  const tx = wasm.Transaction.deserializeFromSafeJSON(json);
  const addresses = [...new Set(tx.inputs.map(input => {
    if (!input.utxo) throw new Error('Missing source UTXO');
    const address = wasm.addressFromScriptPublicKey(input.utxo.scriptPublicKey, 'testnet-10');
    if (!address) throw new Error('Source has no queryable address');
    return address.toString();
  }))];
  const { entries } = await withTimeout(rpc.getUtxosByAddresses({ addresses }), 'Recheck inputs');
  for (const input of tx.inputs) {
    const actual = entries.find(e => e.outpoint.transactionId === input.previousOutpoint.transactionId &&
      e.outpoint.index === input.previousOutpoint.index);
    if (!actual || BigInt(actual.amount) !== input.utxo!.amount ||
        actual.scriptPublicKey.version !== input.utxo!.scriptPublicKey.version ||
        actual.scriptPublicKey.script !== input.utxo!.scriptPublicKey.script)
      throw new Error('Input spent or changed; rebuild and ask the wallet to sign again');
  }
}

export function signedMass(wasm: Runtime, signed: string) {
  const tx = wasm.Transaction.deserializeFromSafeJSON(signed);
  const protocol = createKcc20PsktBuilderEngine({ wasm, artifacts: {} }).protocol;
  const mass = protocol.calculateToccataV1NonContextualMass(tx, 'wallet example');
  const storageMass = protocol.calculateToccataStorageMass(tx, 'wallet example');
  if (mass.computeMass > 450000n || mass.transientMass > 900000n || storageMass > 450000n)
    throw new Error('Signed transaction exceeds the wallet example mass budget');
  return { compute: String(mass.computeMass), transient: String(mass.transientMass), storage: String(storageMass) };
}

export async function broadcastSend(wasm: Runtime, rpc: InstanceType<Runtime['RpcClient']>, signed: string,
  persist: (record: { transactionId: string; signedTransactionJson: string }) => Promise<void>) {
  signedMass(wasm, signed);
  await assertCurrentInputs(wasm, rpc, signed);
  const tx = wasm.Transaction.deserializeFromSafeJSON(signed);
  tx.finalize();
  // A durable host write must finish before submission. On timeout resume by ID.
  await persist({ transactionId: tx.id, signedTransactionJson: tx.serializeToSafeJSON() });
  return withTimeout(rpc.submitTransaction({ transaction: tx, allowOrphan: false }),
    'Broadcast response missing; check saved transaction ID before retrying');
}
