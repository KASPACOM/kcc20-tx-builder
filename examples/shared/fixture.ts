import { network, type Runtime, type Wallet, type Built, type Sources } from './build.ts';
import type { Kcc20IndexedCovenantUtxo } from '@kaspacom/kcc20-tx-builder/action-source-resolver';

// Public secp256k1 generator coordinates, not a wallet intended to receive funds.
export const owner = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
export const recipient = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
export function fixture(wasm: Runtime) {
  const wallet: Wallet = { kcc20Owner: owner, walletAddress: new wasm.XOnlyPublicKey(owner).toAddress(network).toString() };
  const rows = new Map<string, any[]>();
  rows.set(wallet.walletAddress, [{ address: wallet.walletAddress, outpoint: { transactionId: 'ab'.repeat(32), index: 0 }, amount: 100_000_000_000n, scriptPublicKey: wasm.payToAddressScript(wallet.walletAddress), blockDaaScore: 1n, isCoinbase: false }]);
  const sources: Sources = { async getUtxosByAddresses({ addresses }) { return { entries: addresses.flatMap(address => rows.get(address) ?? []) }; } };
  function addDeploy(result: Built): Kcc20IndexedCovenantUtxo {
    const tx = JSON.parse(result.psktTransactionJson);
    const m = result.metadata;
    const address = String(m.contractAddress);
    const index = Number(m.covenantOutputIndex);
    const output = tx.outputs[index];
    const txid = 'cd'.repeat(32); // Synthetic, never submitted or asserted to exist on-chain.
    rows.set(address, [{ address, outpoint: { transactionId: txid, index }, amount: BigInt(output.value), scriptPublicKey: output.scriptPublicKey, covenantId: m.covenantId, blockDaaScore: 1n, isCoinbase: false }]);
    return { txidHex: txid, vout: index, outpoint: `${txid}:${index}`, address, amountSompi: output.value, covenantId: m.covenantId,
      state: { ownerIdentifier: owner, ownerScheme: 0, amount: m.maxSupply, extensionCommitment: m.holderExtensionCommitment, borrowScheme: 0, borrowGuard: '00'.repeat(32), isMintAuthority: false } };
  }
  return { wallet, sources, rows, addDeploy };
}
