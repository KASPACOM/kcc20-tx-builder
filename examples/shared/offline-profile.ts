import {
  BUNDLED_TOKEN_PROFILES,
  BUNDLED_TOKEN_PROFILE_DIGEST,
} from "@kaspacom/kcc20-tx-builder/token-profiles.generated";
import type { AuthenticatedTokenProfileRegistry } from "@kaspacom/kcc20-tx-builder/token-profiles";
import {
  createBuilder,
  type Runtime,
  type Sources,
} from "./build.ts";

/** Offline fixtures use the same authenticated registry as live construction. */
export const OFFLINE_EXAMPLE_TOKEN_PROFILE_REGISTRY: AuthenticatedTokenProfileRegistry =
  Object.freeze({
    manifest: BUNDLED_TOKEN_PROFILES,
    sha256: BUNDLED_TOKEN_PROFILE_DIGEST,
  });

export function createOfflineBuilder(
  wasm: Runtime,
  sources: Sources,
  loadArtifact: (key: string) => Promise<unknown>,
) {
  return createBuilder(wasm, sources, loadArtifact, {
    tokenProfileRegistry: OFFLINE_EXAMPLE_TOKEN_PROFILE_REGISTRY,
  });
}
