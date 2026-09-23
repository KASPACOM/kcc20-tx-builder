import { Kcc20BuilderError } from "./errors.js";
import { createKcc20PsktBuilderEngine } from "./engine.js";
import type { Kcc20PsktBuilderDependencies } from "./models.js";

export const KCC20_PSKT_BUILDER_INPUT_SCHEMA =
  "kcc20-in-process-pskt-builder-input/v1" as const;

export async function buildKcc20Pskt(
  dependencies: Kcc20PsktBuilderDependencies,
  request: Kcc20PsktBuilderInput,
): Promise<Record<string, unknown>> {
  if (request.schema !== KCC20_PSKT_BUILDER_INPUT_SCHEMA) {
    throw new Kcc20BuilderError(
      "INVALID_INPUT",
      `unsupported KCC20 builder input schema: ${String(request.schema || "missing")}`,
    );
  }
  const engine = createKcc20PsktBuilderEngine({
    wasm: dependencies.wasm,
    artifacts: dependencies.artifacts ?? {},
    artifactProvider: dependencies.artifactProvider,
    config: dependencies.config,
    sourceProvider: dependencies.sourceProvider,
    rpcClientFactory: dependencies.rpcClientFactory,
  });
  return engine.build(request);
}

export interface Kcc20PsktBuilderInput {
  schema: typeof KCC20_PSKT_BUILDER_INPUT_SCHEMA;
  schemaVersion?: number;
  builder: Record<string, unknown>;
  request: Record<string, unknown>;
}
