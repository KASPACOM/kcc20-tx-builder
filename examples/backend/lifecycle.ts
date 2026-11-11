import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runtime, loadArtifact } from './runtime.ts';
import { lifecycleBuilder, validateRequest, walletDebit, resumeAcceptance, network, type Signer } from '../shared/lifecycle.ts';
import { withTimeout } from '../shared/timeout.ts';

const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2) + '\n';
const { values: v } = parseArgs({ options: {
  request: { type: 'string' }, rpc: { type: 'string' }, evidence: { type: 'string' },
  signer: { type: 'string' }, submit: { type: 'boolean', default: false },
  'max-debit-sompi': { type: 'string' }, rest: { type: 'string' },
  resume: { type: 'boolean', default: false },
} });
async function main() {
  if (!v.evidence) throw new Error('--evidence is required (use a new file for each build)');
  if (v.resume) {
    if (v.submit || !v.rest) throw new Error('--resume requires --rest and never resubmits');
    const record = JSON.parse(await readFile(v.evidence, 'utf8'));
    console.log(json(await resumeAcceptance(v.rest, record)));
    return;
  }
  if (!v.request || !v.rpc) throw new Error('--request and --rpc are required');
  if (v.submit && (!v.signer || !v['max-debit-sompi'])) throw new Error('--submit requires --signer and --max-debit-sompi');
  const request = JSON.parse(await readFile(v.request, 'utf8'));
  validateRequest(request);
  const wasm = await runtime();
  const rpc = new wasm.RpcClient({ url: v.rpc, networkId: network, encoding: wasm.Encoding.Borsh });
  try {
    await withTimeout(rpc.connect(), 'RPC connect');
    const server = await withTimeout(rpc.getServerInfo(), 'Node identity');
    if (server.networkId !== network || !server.isSynced) throw new Error('Expected a synced TN10 node');
    // The signer is trusted host code, never supplied by the backend or an API response.
    const signer: Signer | undefined = v.signer
      ? (await import(pathToFileURL(resolve(v.signer)).href)).default : undefined;
    const builder = lifecycleBuilder(wasm, rpc, loadArtifact, signer?.capabilities);
    const built = await builder.build(request);
    const debit = walletDebit(wasm, built, request.request.owner.walletAddress);
    if (v['max-debit-sompi'] && (!/^[0-9]+$/.test(v['max-debit-sompi']) || debit > BigInt(v['max-debit-sompi'])))
      throw new Error('Wallet debit exceeds the explicit cap');
    const pkg = JSON.parse(await readFile(new URL(import.meta.resolve('@kaspacom/kcc20-tx-builder/package.json')), 'utf8'));
    const record: Record<string, unknown> = { schema: 'kcc20-public-example/v1', network,
      packageVersion: pkg.version, request, built, walletDebitSompi: debit,
      status: 'built', indexed: 'not checked' };
    // Reserve the journal before invoking a signer or broadcasting.
    await writeFile(v.evidence, json(record), { flag: 'wx', mode: 0o600 });
    if (!v.submit) { console.log(json({ status: 'built', evidence: v.evidence, walletDebitSompi: debit })); return; }
    const signed = await builder.sign(built, signer!);
    record.transactionId = signed.transaction.id;
    record.signedTransaction = signed.signed;
    record.mass = signed.mass;
    record.status = 'signed-before-broadcast';
    await writeFile(v.evidence, json(record));
    await builder.assertFresh(built);
    const result = await withTimeout(rpc.submitTransaction({ transaction: signed.transaction, allowOrphan: false }), 'Broadcast');
    record.broadcastTransactionId = result.transactionId;
    if (result.transactionId !== record.transactionId) {
      record.status = 'broadcast-id-mismatch';
      await writeFile(v.evidence, json(record));
      throw new Error('Node returned a different transaction ID; inspect the journal before retrying');
    }
    record.status = 'submitted';
    await writeFile(v.evidence, json(record));
    console.log(json({ status: record.status, transactionId: record.transactionId, mass: record.mass, indexed: 'not checked' }));
  } finally { await withTimeout(rpc.disconnect(), 'RPC disconnect', 5_000).catch(() => undefined); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
