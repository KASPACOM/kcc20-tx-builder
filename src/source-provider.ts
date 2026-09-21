import type { BuildSources, Kcc20PsktBuildRequest } from "./models.js";

/**
 * Application-specific source preparation belongs outside the protocol core.
 *
 * The backend implementation can satisfy this interface from its indexer/RPC
 * providers. The frontend implementation can satisfy it from API snapshots
 * and wallet-owned UTXOs. The builder itself only consumes the returned data.
 */
export interface Kcc20SourceProvider {
  getSources(request: Kcc20PsktBuildRequest): Promise<BuildSources>;
}
