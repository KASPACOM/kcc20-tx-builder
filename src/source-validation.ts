import { Kcc20BuilderError } from "./errors.js";
import type { BuildSources, TransactionOutpoint } from "./models.js";

export interface SourceSnapshotMetadata {
  snapshotId: string;
  expiresAt?: string;
  revision?: string;
}

export function outpointKey(outpoint: TransactionOutpoint): string {
  return `${outpoint.txidHex.toLowerCase()}:${outpoint.vout}`;
}

export function assertUniqueSources(sources: BuildSources): void {
  const seen = new Set<string>();
  const all = [
    ...(sources.covenantUtxos ?? []),
    ...sources.walletUtxos,
    ...(sources.optionalFeeTicketUtxos ?? []),
  ];
  for (const source of all) {
    const key = outpointKey(source);
    if (seen.has(key)) {
      throw new Kcc20BuilderError(
        "INVALID_INPUT",
        `duplicate source outpoint: ${key}`,
        { outpoint: key },
      );
    }
    seen.add(key);
  }
}

export function assertSnapshotFresh(
  metadata: SourceSnapshotMetadata | undefined,
  now = Date.now(),
): void {
  if (!metadata?.expiresAt) return;
  const expiresAt = Date.parse(metadata.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Kcc20BuilderError(
      "STALE_SOURCE",
      "source snapshot is missing a valid future expiry",
      { snapshotId: metadata.snapshotId },
    );
  }
}
