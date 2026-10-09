import { withTimeout } from '../shared/timeout.ts';
import { runtime, loadArtifact } from './runtime.ts';
import { createBuilder, deployOperation, transferOperation, inspect, network, type Built } from '../shared/build.ts';
import { fixture, recipient } from '../shared/fixture.ts';
import { attachScripts, signingInputs } from '../shared/signing.ts';
const status = document.querySelector('#status')!;
const output = document.querySelector('#result')!;
const sign = document.querySelector<HTMLButtonElement>('#sign')!;
const broadcast = document.querySelector<HTMLButtonElement>('#broadcast')!;
let built: Built | undefined;
let signed: string | undefined;
let rpc: InstanceType<Awaited<ReturnType<typeof runtime>>['RpcClient']> | undefined;
let buildAddress = '';
let busy = false;
async function action(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button, input, textarea').forEach(element => (element as HTMLInputElement).disabled = true);
  status.textContent = 'Working';
  try { await fn(); status.textContent = 'Complete'; }
  catch (error) { await clear(); status.textContent = String(error); }
  finally {
    busy = false;
    document.querySelectorAll('button, input, textarea').forEach(element => (element as HTMLInputElement).disabled = false);
    sign.disabled = !built;
    broadcast.disabled = !signed;
  }
}
async function clear() {
  built = undefined; signed = undefined; sign.disabled = true; broadcast.disabled = true;
  if (rpc) await withTimeout(rpc.disconnect(), 'RPC disconnect', 5_000).catch(() => undefined);
  rpc = undefined;
}
export async function offline() {
  const wasm = await runtime();
  const data = fixture(wasm);
  const build = createBuilder(wasm, data.sources, loadArtifact);
  const deploy = await build(deployOperation(data.wallet));
  const transfer = await build(transferOperation(data.wallet, data.addDeploy(deploy), recipient));
  return { deploy, transfer };
}
// Used by the browser acceptance test, which blocks every external request.
Object.assign(window, { runOfflineExample: offline });
document.querySelector('#offline')!.addEventListener('click', () => action(async () => {
  await clear();
  const result = await offline();
  output.textContent = JSON.stringify({ deploy: inspect(result.deploy), transfer: inspect(result.transfer) }, null, 2);
}));
document.querySelector('#prepare')!.addEventListener('click', () => action(async () => {
  await clear();
  const wallet = (window as any).kasware;
  if (!wallet?.getPublicKey) throw new Error('Install KasWare to prepare a live deploy');
  if (await wallet.getNetwork() !== 'kaspa_testnet_10') throw new Error('Select TN10 in KasWare');
  const [walletAddress] = await wallet.requestAccounts();
  if (!walletAddress) throw new Error('Wallet did not return an account');
  const wasm = await runtime();
  const publicKey = await wallet.getPublicKey();
  const owner = publicKey.length === 64 ? publicKey : new wasm.PublicKey(publicKey).toXOnlyPublicKey().toString();
  if (new wasm.XOnlyPublicKey(owner).toAddress(network).toString() !== walletAddress) throw new Error('Wallet address and public key do not match');
  const operation = deployOperation({ walletAddress, kcc20Owner: owner });
  document.querySelector<HTMLTextAreaElement>('#operation')!.value = JSON.stringify(operation, null, 2);
  output.textContent = 'Deploy operation prepared locally. Review the token parameters, choose your RPC, then build.';
}));
document.querySelector('#build')!.addEventListener('click', () => action(async () => {
  await clear();
  const wasm = await runtime();
  const operation = JSON.parse(document.querySelector<HTMLTextAreaElement>('#operation')!.value);
  const url = document.querySelector<HTMLInputElement>('#rpc')!.value;
  if (!/^wss?:\/\//.test(url)) throw new Error('Enter your TN10 WebSocket RPC URL');
  rpc = new wasm.RpcClient({ url, networkId: network, encoding: wasm.Encoding.Borsh });
  await withTimeout(rpc.connect(), 'RPC connection');
  if ((await withTimeout(rpc.getBlockDagInfo(), 'Network query')).network !== network) throw new Error('RPC network mismatch');
  built = await createBuilder(wasm, rpc, loadArtifact)(operation);
  buildAddress = operation.payload.owner.walletAddress;
  output.textContent = JSON.stringify({ inspection: inspect(built), transaction: built }, null, 2);
  sign.disabled = false;
}));
sign.addEventListener('click', () => action(async () => {
  signed = undefined; broadcast.disabled = true;
  const wallet = (window as any).kasware;
  if (!built || !wallet?.signPskt) throw new Error('Install a KasWare version with PSKT signing');
  if (await wallet.getNetwork() !== 'kaspa_testnet_10') throw new Error('Select TN10 in KasWare');
  if ((await wallet.requestAccounts())[0] !== buildAddress) throw new Error('Wallet account differs from transaction owner');
  const json = await wallet.signPskt({ txJsonString: built.psktTransactionJson, options: { signInputs: signingInputs(built) } });
  signed = attachScripts(await runtime(), json, built);
  output.textContent = signed!;
  broadcast.disabled = false;
}));
broadcast.addEventListener('click', () => action(async () => {
  if (!signed || !rpc) throw new Error('Build and sign first');
  if (!confirm('Broadcast this signed transaction to TN10?')) return;
  const wasm = await runtime();
  const result = await withTimeout(rpc.submitTransaction({ transaction: wasm.Transaction.deserializeFromSafeJSON(signed), allowOrphan: false }), 'Submission; check transaction acceptance before retrying');
  output.textContent = JSON.stringify(result);
  signed = undefined; built = undefined;
  await clear();
}));
