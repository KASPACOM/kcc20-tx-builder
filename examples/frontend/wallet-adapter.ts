import type { Runtime } from '../shared/build.ts';
import { buildSend, signSend, type SendRequest } from '../shared/wallet-send.ts';

// Reuse the host wallet's RPC; do not open a second browser connection.
// Connect this to the wallet's review/sign interaction, not automatic page load.
export async function prepareAndSignSend(wasm: Runtime, rpc: InstanceType<Runtime['RpcClient']>,
  loadArtifact: (key: string) => Promise<unknown>, request: SendRequest,
  wallet: { signPsktTransaction(json: string, options: { signInputs: unknown[] }): Promise<string> }) {
  const built = await buildSend(wasm, rpc, loadArtifact, request);
  return signSend(wasm, rpc, built, (json, inputs) => wallet.signPsktTransaction(json, { signInputs: inputs }));
}
