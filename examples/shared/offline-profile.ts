import {
  BUNDLED_TOKEN_PROFILES,
} from "@kaspacom/kcc20-tx-builder/token-profiles.generated";
import type { AuthenticatedTokenProfileRegistry } from "@kaspacom/kcc20-tx-builder/token-profiles";
import {
  createBuilder,
  type Runtime,
  type Sources,
} from "./build.ts";

const manifest = structuredClone(BUNDLED_TOKEN_PROFILES);
const nativeProfile = manifest.profiles.find((profile) => profile.nativeExtensions);
if (!nativeProfile) throw new Error("Offline native KCC20 profile is unavailable");
nativeProfile.review = {
  status: "approved",
  evidence: ["offline-example-test-vectors"],
};
nativeProfile.fundedTradingVerified = true;

/** Synthetic offline fixtures only. Never use this registry for live construction. */
export const OFFLINE_EXAMPLE_TOKEN_PROFILE_REGISTRY: AuthenticatedTokenProfileRegistry =
  Object.freeze({
    manifest,
    sha256: "0e683704a52752e516d59a3200c78514626ea1301bad150c401e8b292393350e",
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
