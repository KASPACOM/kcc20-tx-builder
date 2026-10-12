import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime, loadArtifact } from "../backend/runtime.ts";
import { createBuilder, deployOperation, network } from "../shared/build.ts";
import { fixture, recipient } from "../shared/fixture.ts";
import { liveTransferOperation } from "../shared/live-transfer.ts";
const wasm = await runtime();
async function setup() {
  const data = fixture(wasm);
  const build = createBuilder(wasm, data.sources, loadArtifact);
  const holder = data.addDeploy(await build(deployOperation(data.wallet)));
  const config = {
    network,
    stateUrl: "https://indexer.example/holders",
    wallet: data.wallet,
    covenantId: holder.covenantId!,
    decimals: 2,
    recipientOwner: recipient,
    tokenAmount: "12.50",
  } as const;
  const document = { network, utxos: [holder] };
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify(document), { status: 200 });
  return { data, build, config, document, fetcher, holder };
}
test("decoded endpoint data and RPC produce a real unsigned transfer", async () => {
  const { data, build, config, fetcher } = await setup();
  const operation = await liveTransferOperation(
    wasm,
    data.sources,
    loadArtifact,
    config,
    fetcher,
  );
  const result = await build(operation);
  assert.equal(result.metadata.tokenAmount, "1250");
  assert.equal(result.metadata.covenantId, config.covenantId);
});
for (const failure of [
  "network",
  "spent",
  "amount",
  "identity",
  "script",
  "state",
  "duplicate",
  "decimals",
  "owner",
] as const) {
  test(`reject invalid live transfer source: ${failure}`, async () => {
    const { data, config, document, fetcher, holder } = await setup();
    const row = data.rows.get(holder.address)![0];
    if (failure === "network") document.network = "mainnet";
    if (failure === "spent") data.rows.delete(holder.address);
    if (failure === "amount") row.amount += 1n;
    if (failure === "identity") row.covenantId = "ff".repeat(32);
    if (failure === "script")
      row.scriptPublicKey = wasm.payToAddressScript(data.wallet.walletAddress);
    if (failure === "state")
      holder.state!.extensionCommitment = "ff".repeat(32);
    if (failure === "duplicate") document.utxos.push(holder);
    const input = {
      ...config,
      ...(failure === "decimals" ? { decimals: 9 } : {}),
      ...(failure === "owner"
        ? { wallet: { ...config.wallet, kcc20Owner: recipient } }
        : {}),
    };
    await assert.rejects(
      liveTransferOperation(wasm, data.sources, loadArtifact, input, fetcher),
    );
  });
}

test("lightweight indexer rows build the same unsigned transfer through RPC", async () => {
  const { data, build, config, holder, fetcher: baselineFetcher } = await setup();
  const baseline = await build(await liveTransferOperation(wasm, data.sources, loadArtifact, config, baselineFetcher));
  const current = data.rows.get(holder.address)![0];
  const page = {
    network, fresh: true, nextCursor: null,
    items: [{ verified: true, family: "KCC20", covenantId: holder.covenantId,
      outpoint: `${holder.txidHex}:${holder.vout}`, kasAmount: holder.amountSompi,
      scriptPublicKey: typeof current.scriptPublicKey === "string"
        ? { version: Number.parseInt(current.scriptPublicKey.slice(0, 4), 16), script: current.scriptPublicKey.slice(4) }
        : { version: current.scriptPublicKey.version, script: current.scriptPublicKey.script },
      state: { ...holder.state, owner: holder.state!.ownerIdentifier } }],
  };
  const fetcher: typeof fetch = async () => new Response(JSON.stringify(page));
  const operation = await liveTransferOperation(wasm, data.sources, loadArtifact, config, fetcher);
  const built = await build(operation);
  assert.equal(built.metadata.tokenAmount, "1250");
  assert.equal(built.metadata.covenantId, config.covenantId);
  assert.deepEqual(JSON.parse(built.psktTransactionJson), JSON.parse(baseline.psktTransactionJson));
  assert.deepEqual(built.signInputs, baseline.signInputs);
  assert.deepEqual(built.scripts, baseline.scripts);
  page.nextCursor = "another-page" as any;
  let calls = 0;
  await assert.rejects(liveTransferOperation(wasm, data.sources, loadArtifact, config, async () =>
    new Response(JSON.stringify({ ...page, nextCursor: calls++ === 0 ? "another-page" : null }))), /duplicate/);
  page.nextCursor = null;
  page.fresh = false;
  await assert.rejects(liveTransferOperation(wasm, data.sources, loadArtifact, config, fetcher), /stale/);
});

for (const invalid of ["numeric-kas", "numeric-token", "overflow-kas", "negative-token", "script-version", "outpoint-leading-zero"] as const) {
  test(`lightweight adapter rejects ${invalid} before transaction construction`, async () => {
    const { data, config, holder } = await setup();
    const current = data.rows.get(holder.address)![0];
    const row: Record<string, any> = {
      verified: true, family: "KCC20", covenantId: holder.covenantId,
      outpoint: `${holder.txidHex}:${holder.vout}`, kasAmount: holder.amountSompi,
      scriptPublicKey: typeof current.scriptPublicKey === "string"
        ? { version: Number.parseInt(current.scriptPublicKey.slice(0, 4), 16), script: current.scriptPublicKey.slice(4) }
        : { version: current.scriptPublicKey.version, script: current.scriptPublicKey.script },
      state: { ...holder.state, owner: holder.state!.ownerIdentifier },
    };
    if (invalid === "numeric-kas") row.kasAmount = 9007199254740993;
    if (invalid === "numeric-token") row.state.amount = 50;
    if (invalid === "overflow-kas") row.kasAmount = "18446744073709551616";
    if (invalid === "negative-token") row.state.amount = "-1";
    if (invalid === "script-version") row.scriptPublicKey.version = "0";
    if (invalid === "outpoint-leading-zero") row.outpoint = `${holder.txidHex}:00`;
    const page = { network, fresh: true, nextCursor: null, items: [row] };
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(page));
    await assert.rejects(liveTransferOperation(wasm, data.sources, loadArtifact, config, fetcher), /Invalid|Incomplete/);
  });
}

test("lightweight pagination follows empty filtered pages and rejects repeated cursors", async () => {
  const { readLightweightPages } = await import("../shared/lightweight-indexer.ts");
  const first = { network, fresh: true, nextCursor: "utxo/first", items: [] };
  const url = new URL("https://indexer.example/v1/sources?covenantId=" + "ab".repeat(32));
  let requested = "";
  const fetcher: typeof fetch = async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({ ...first, nextCursor: null }));
  };
  assert.deepEqual(await readLightweightPages(wasm, first, url, fetcher), []);
  assert.equal(new URL(requested).searchParams.get("after"), "utxo/first");
  assert.equal(new URL(requested).searchParams.get("covenantId"), "ab".repeat(32));
  await assert.rejects(readLightweightPages(wasm, first, url, async () =>
    new Response(JSON.stringify(first))), /repeated pagination cursor/);
  await assert.rejects(readLightweightPages(wasm, first, url, async () =>
    new Response(JSON.stringify({ ...first, fresh: false }))), /stale/);
  await assert.rejects(readLightweightPages(wasm, first, url, async () =>
    new Response(JSON.stringify({ ...first, network: "mainnet" }))), /network/);
  let page = 0;
  await assert.rejects(readLightweightPages(wasm, first, url, async () =>
    new Response(JSON.stringify({ ...first, nextCursor: `page-${++page}` }))), /exceeded 100 pages/);
});
