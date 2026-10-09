import { withTimeout } from '../shared/timeout.ts';
import { readFile } from 'node:fs/promises';
import { runtime, loadArtifact } from './runtime.ts';
import { createBuilder, deployOperation, transferOperation, inspect, network } from '../shared/build.ts';
import { fixture, recipient } from '../shared/fixture.ts';
const wasm = await runtime();
const mode = process.argv[2] ?? 'offline';
if (mode === 'offline') {
  const data = fixture(wasm);
  const build = createBuilder(wasm, data.sources, loadArtifact);
  const deploy = await build(deployOperation(data.wallet));
  const transfer = await build(transferOperation(data.wallet, data.addDeploy(deploy), recipient));
  console.log(JSON.stringify({ deploy: inspect(deploy), transfer: inspect(transfer) }, null, 2));
} else if (mode === 'build') {
  const path = process.argv[3];
  if (!path || !process.env.KASPA_WRPC_URL) throw new Error('Usage: KASPA_WRPC_URL=wss://your-node npm run backend -- build operation.json');
  const operation = JSON.parse(await readFile(path, 'utf8'));
  const rpc = new wasm.RpcClient({ url: process.env.KASPA_WRPC_URL, encoding: wasm.Encoding.Borsh, networkId: network });
  try {
    await withTimeout(rpc.connect(), 'RPC connection');
    const info = await withTimeout(rpc.getBlockDagInfo(), 'Network query');
    if (info.network !== network) throw new Error(`RPC network mismatch: ${info.network}`);
    const result = await createBuilder(wasm, rpc, loadArtifact)(operation);
    console.log(JSON.stringify(result, null, 2));
  } finally { await withTimeout(rpc.disconnect(), 'RPC disconnect', 5_000); }
} else throw new Error('Expected offline or build');
