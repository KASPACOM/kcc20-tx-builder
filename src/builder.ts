import { Kcc20BuilderError } from "./errors.js";
import { createKcc20PsktBuilderEngine } from "./engine.js";
import type {
  Kcc20PsktBuildRequest,
  Kcc20PsktBuildResult,
  Kcc20PsktBuilderDependencies,
} from "./models.js";

export async function buildKcc20Pskt(
  dependencies: Kcc20PsktBuilderDependencies,
  request: Kcc20PsktBuildRequest | Kcc20LegacyPsktBuilderInput,
): Promise<Kcc20PsktBuildResult | Record<string, unknown>> {
  if (isLegacyInput(request)) {
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

  throw new Kcc20BuilderError(
    "UNSUPPORTED_OPERATION",
    "the canonical shared request adapter is not yet enabled; use the legacy input adapter during migration",
    { builderKey: request.builderKey },
  );
}

export interface Kcc20LegacyPsktBuilderInput {
  schema: "kcc20-in-process-pskt-builder-input/v1";
  schemaVersion?: number;
  builder: Record<string, unknown>;
  request: Record<string, unknown>;
}

function isLegacyInput(
  request: Kcc20PsktBuildRequest | Kcc20LegacyPsktBuilderInput,
): request is Kcc20LegacyPsktBuilderInput {
  return request.schema === "kcc20-in-process-pskt-builder-input/v1";
}
