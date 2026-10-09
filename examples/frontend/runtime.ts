import * as wasm from '../vendor/kaspa/kaspa.js';
let initialized: Promise<unknown> | undefined;
export async function runtime() {
  initialized ??= wasm.default({ module_or_path: new URL('../vendor/kaspa/kaspa_bg.wasm', import.meta.url) });
  await initialized;
  wasm.initWASM32Bindings({ validateClassNames: false });
  return wasm;
}
const artifacts = import.meta.glob('../node_modules/@kaspacom/kcc20-tx-builder/artifacts/*.json', { import: 'default' });
export async function loadArtifact(key: string) {
  const load = artifacts[`../node_modules/@kaspacom/kcc20-tx-builder/artifacts/${key}`];
  if (!load) throw new Error(`Missing packaged artifact ${key}`);
  return load();
}
