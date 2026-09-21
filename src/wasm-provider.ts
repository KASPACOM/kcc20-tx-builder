import type { KaspaWasmProvider, KaspaWasmRuntime } from "./runtime.js";

export interface WasmModuleLoader<TModule> {
  load(): Promise<TModule>;
}

export interface WasmModuleInitializer<TModule> {
  initialize(module: TModule): Promise<KaspaWasmRuntime> | KaspaWasmRuntime;
}

/**
 * Creates a cached provider for either the browser or Node WASM module.
 *
 * The loader and initializer are deliberately supplied by the host. This
 * keeps URL resolution, initSync, initWASM32Bindings, and binary loading
 * outside the shared package.
 */
export function createKaspaWasmProvider<TModule>(
  loader: WasmModuleLoader<TModule>,
  initializer: WasmModuleInitializer<TModule>,
): KaspaWasmProvider {
  let runtimePromise: Promise<KaspaWasmRuntime> | undefined;

  return {
    getRuntime(): Promise<KaspaWasmRuntime> {
      runtimePromise ??= Promise.resolve(loader.load()).then((module) =>
        initializer.initialize(module),
      );
      return runtimePromise;
    },
  };
}
