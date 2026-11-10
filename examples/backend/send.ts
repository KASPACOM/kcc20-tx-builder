import { readFile } from 'node:fs/promises';
import { runtime, loadArtifact } from './runtime.ts';
import { buildSend, type SendRequest } from '../shared/wallet-send.ts';
import { withTimeout } from '../shared/timeout.ts';
const file = process.argv[2];
if (!file || !process.env.KASPA_WRPC_URL) throw new Error('Usage: KASPA_WRPC_URL=<node> npm run wallet:send -- request.json');
const request: SendRequest = JSON.parse(await readFile(file, 'utf8'));
const wasm = await runtime();
const rpc = new wasm.RpcClient({ url: process.env.KASPA_WRPC_URL, networkId: 'testnet-10', encoding: wasm.Encoding.Borsh });
try {
  await withTimeout(rpc.connect(), 'Connect');
  console.log(JSON.stringify(await buildSend(wasm, rpc, loadArtifact, request), null, 2));
} finally { await withTimeout(rpc.disconnect(), 'Disconnect', 5000); }
