import type { KaspaWasmRuntime } from "./runtime.js";

export const KCC20_BUILDER_INPUT_SCHEMA =
  "kcc20-shared-pskt-builder-input/v1" as const;
export const KCC20_BUILDER_OUTPUT_SCHEMA =
  "kcc20-shared-pskt-builder-output/v1" as const;

export type Hex64 = string;

export interface TransactionOutpoint {
  txidHex: Hex64;
  vout: number;
}

export interface CovenantUtxo extends TransactionOutpoint {
  address: string;
  amountSompi: string;
  /** Decoded state required by the selected operation. */
  state: Record<string, unknown>;
  /** Optional script/artifact data supplied by the source resolver. */
  scriptHex?: string;
  artifactKey?: string;
}

export interface FundingUtxo extends TransactionOutpoint {
  address: string;
  amountSompi: string;
  scriptPublicKeyHex?: string;
}

export interface BuildSources {
  covenantUtxos?: CovenantUtxo[];
  walletUtxos: FundingUtxo[];
  optionalFeeTicketUtxos?: CovenantUtxo[];
}

export interface ArtifactDescriptor {
  key: string;
  version: string;
  hash: Hex64;
  abi?: unknown;
  script?: unknown;
}

export interface BuildContext {
  network: string;
  walletAddress: string;
  ownerIdentifier: string;
  protocolVersion: string;
  artifacts: Record<string, ArtifactDescriptor>;
  /** Values normally controlled by backend configuration. */
  protocolFeeBps?: string;
  priorityFeeSompi?: string;
}

export interface Kcc20PsktBuildRequest {
  schema: typeof KCC20_BUILDER_INPUT_SCHEMA;
  builderKey: string;
  operation: string;
  action: string;
  params: Record<string, unknown>;
  context: BuildContext;
  sources: BuildSources;
}

export interface SignInput {
  index: number;
  sighashType?: number;
}

export interface CovenantSigningScript {
  inputIndex: number;
  scriptHex: string;
  signType?: string;
  signatureScriptHex?: string;
}

export interface Kcc20PsktBuildResult {
  schema: typeof KCC20_BUILDER_OUTPUT_SCHEMA;
  psktTransactionJson: string;
  signInputs: SignInput[];
  scripts?: CovenantSigningScript[];
  sourceOutpoints: string[];
  artifactHashes: Record<string, Hex64>;
  operationDigest: Hex64;
  metadata?: Record<string, unknown>;
}

export interface Kcc20PsktBuilderDependencies {
  wasm: KaspaWasmRuntime;
  artifacts?: Record<string, unknown>;
  artifactProvider?: (key: string) => Promise<unknown>;
  config?: Record<string, unknown>;
  /**
   * Host-owned source transport. When supplied, the builder does not create,
   * connect, or disconnect an RPC client; the host may therefore back this
   * provider with one long-lived browser or server connection.
   */
  sourceProvider?: {
    getUtxosByAddresses(args: { addresses: string[] }): Promise<unknown>;
  };
  rpcClientFactory?: (config: unknown) => any;
}
