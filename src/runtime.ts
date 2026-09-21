/**
 * The shared package receives a runtime from its host application.
 *
 * Do not replace this with an import from either Kaspa WASM build. The browser
 * and Node applications initialize different binaries and use different asset
 * loading mechanisms.
 */
/**
 * A loaded Kaspa module supplied by the host application. The shared package
 * intentionally does not prescribe the exact generated-WASM TypeScript
 * declarations. Operation modules should narrow the capabilities they use.
 */
export interface KaspaWasmRuntime {
  readonly [capability: string]: unknown;
}

export interface CoreKaspaWasmCapabilities extends KaspaWasmRuntime {
  readonly addressFromScriptPublicKey: (...args: any[]) => any;
  readonly payToScriptHashScript: (...args: any[]) => any;
  readonly payToAddressScript: (...args: any[]) => any;
  readonly ScriptBuilder: any;
  readonly Transaction: any;
  readonly TransactionInput: any;
  readonly TransactionOutput: any;
}

export interface KaspaWasmProvider {
  getRuntime(): Promise<KaspaWasmRuntime>;
}
