import assert from "node:assert/strict";
import { preview } from "vite";
import { chromium } from "playwright";
import { runtime, loadArtifact } from "../backend/runtime.ts";
import {
  createBuilder,
  deployOperation,
  transferOperation,
} from "../shared/build.ts";
import { recipeFixtures } from "../shared/recipe-fixtures.ts";
import { recipes } from "../shared/recipes.ts";
import { fixture, recipient, owner } from "../shared/fixture.ts";
const server = await preview({
  root: "frontend",
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const external: string[] = [];
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== "http://127.0.0.1:4173") {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.routeWebSocket(/.*/, (socket) => {
    external.push(socket.url());
    socket.close();
  });
  await page.goto("http://127.0.0.1:4173");
  await page.waitForFunction(
    () => typeof (window as any).runOfflineExample === "function",
  );
  const browserResult = await page.evaluate(() =>
    (window as any).runOfflineExample(),
  );
  const wasm = await runtime();
  const data = fixture(wasm);
  const build = createBuilder(wasm, data.sources, loadArtifact);
  const deploy = await build(deployOperation(data.wallet));
  const transfer = await build(
    transferOperation(data.wallet, data.addDeploy(deploy), recipient),
  );
  for (const [key, node] of Object.entries({ deploy, transfer })) {
    assert.deepEqual(
      JSON.parse(browserResult[key].psktTransactionJson),
      JSON.parse(node.psktTransactionJson),
    );
    assert.deepEqual(browserResult[key].signInputs, node.signInputs);
    assert.deepEqual(browserResult[key].scripts, node.scripts);
  }
  const all = await recipeFixtures(wasm, loadArtifact);
  for (const name of Object.keys(recipes) as (keyof typeof recipes)[]) {
    const nodeResult = await all.build(all.operation(name));
    const browserRecipe = await page.evaluate(
      (name) => (window as any).runOfflineRecipe(name),
      name,
    );
    assert.deepEqual(
      JSON.parse(browserRecipe.psktTransactionJson),
      JSON.parse(nodeResult.psktTransactionJson),
      name,
    );
    assert.deepEqual(browserRecipe.scripts, nodeResult.scripts, name);
    assert.deepEqual(browserRecipe.signInputs, nodeResult.signInputs, name);
  }
  assert.deepEqual(external, []);
  await page
    .getByRole("button", { name: "Build offline deploy and transfer" })
    .click();
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "Complete",
  );
  assert.equal(await page.locator("#sign").isDisabled(), true);
  assert.equal(await page.locator("#broadcast").isDisabled(), true);
  await page.evaluate(`window.kasware = {
    getNetwork: async () => 'kaspa_testnet_10',
    requestAccounts: async () => [${JSON.stringify(data.wallet.walletAddress)}],
    getPublicKey: async () => ${JSON.stringify("02" + owner)},
    signPskt: async () => { throw new Error('Preparing an operation must not sign'); }
  }`);
  await page
    .getByRole("button", { name: "Prepare deploy from KasWare account" })
    .click();
  await page.waitForFunction(
    () =>
      (document.querySelector("#operation") as HTMLTextAreaElement).value
        .length > 0,
  );
  const prepared = JSON.parse(await page.locator("#operation").inputValue());
  assert.equal(prepared.payload.owner.kcc20Owner, owner);
  assert.equal(prepared.payload.signing.builderKey, "kcc20.deploy-token");
  assert.equal(await page.locator("#sign").isDisabled(), true);
  await page
    .getByRole("button", { name: "Build offline recipe", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "Complete",
  );
  assert.equal(await page.locator("#sign").isDisabled(), true);
  assert.equal(await page.locator("#broadcast").isDisabled(), true);
  await page.screenshot({
    path: "/tmp/kcc20-public-examples.png",
    fullPage: false,
  });
  console.log(
    "Browser/Node all 24 recipes are identical; no external requests; offline signing disabled.",
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}
