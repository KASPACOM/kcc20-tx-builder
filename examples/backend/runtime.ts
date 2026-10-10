import { readFile } from 'node:fs/promises';
import * as wasm from '../vendor/kaspa/kaspa.js';
let initialized: Promise<unknown> | undefined;
export async function runtime() {
  initialized ??= readFile(new URL('../vendor/kaspa/kaspa_bg.wasm', import.meta.url)).then(bytes => wasm.default({ module_or_path: bytes }));
  await initialized;
  wasm.initWASM32Bindings({ validateClassNames: false });
  return wasm;
}
export async function loadArtifact(key: string) {
  const path = import.meta.resolve(`@kaspacom/kcc20-tx-builder/artifacts/${key}`);
  return JSON.parse(await readFile(new URL(path), 'utf8'));
}
