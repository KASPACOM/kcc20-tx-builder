import { readFile } from 'node:fs/promises';
import { runtime, loadArtifact } from './runtime.ts';
import { liveTransferOperation } from '../shared/live-transfer.ts';
import { engineInput } from '../shared/build.ts';
import { withTimeout } from '../shared/timeout.ts';
try {
  if (!process.argv[2] || !process.env.KASPA_WRPC_URL) throw new Error('Usage: KASPA_WRPC_URL=wss://your-node npm run --silent transfer-request -- config.json');
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (config.network !== 'testnet-10') throw new Error('Expected testnet-10');
  const wasm = await runtime();
  const rpc = new wasm.RpcClient({ url: process.env.KASPA_WRPC_URL, networkId: 'testnet-10', encoding: wasm.Encoding.Borsh });
  try {
    await withTimeout(rpc.connect(), 'RPC connection');
    const info = await withTimeout(rpc.getServerInfo(), 'Node identity');
    if (info.networkId !== 'testnet-10' || !info.isSynced) throw new Error('Expected a synced TN10 node');
    console.log(JSON.stringify(engineInput(await liveTransferOperation(wasm, rpc, loadArtifact, config)), null, 2));
  } finally { await withTimeout(rpc.disconnect(), 'RPC disconnect', 5000).catch(() => undefined); }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
