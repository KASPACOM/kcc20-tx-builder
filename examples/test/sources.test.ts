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
