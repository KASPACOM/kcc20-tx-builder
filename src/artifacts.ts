import { Kcc20BuilderError } from "./errors.js";
import type { ArtifactDescriptor, BuildContext } from "./models.js";
import { sha256 } from "@noble/hashes/sha256";

/** The only native KCC20 artifact used to build new transactions. */
export const KCC20_CURRENT_NATIVE_ARTIFACT_KEY =
  "KCC20.placeholder.json" as const;

export const KCC20_ARTIFACT_SCRIPT_SHA256 = Object.freeze({
  "KCC20SnapshotBootstrap.placeholder.json":
    "3d64211a2b3c5ac24009b9ce59d4e8ecb8f2114dbf0c43b5a060b2ed91704e02",
  "KCC20SnapshotController.placeholder.json":
    "fdc2e396a66a1f708522d68f879ec67d71bd0070c7417b1e7f5dd3a6c8cfda88",
  [KCC20_CURRENT_NATIVE_ARTIFACT_KEY]:
    "dd9cb334cd9e9220b15644782f271ef3ecdba34fd0762010e3d6bc18176837ae",
  "KCC20FeeTicket.placeholder.json":
    "c0e95cb8e5226462674647f86d5760626b5c38b7bd97a6e2ec9ba61fdef8941f",
  "KCC20Orderbook.placeholder.json":
    "ef9fe81ff7aa2dc2df118d8d7cc126aca6f2f9c181b9c2d15727a538b23c6f71",
  "KCC20Wrapper.placeholder.json":
    "23cbd5473860cab4e63890d24ae1bd6732fce5beaa34f594dad01e845e3e9b9f",
  "KCC20Vesting.placeholder.json":
    "e32d9f5bde124526475a61075ba46eef41955d4662b1422713860cfbd7a59661",
});

/**
 * Canonical raw artifact pins and structural metadata for signerless snapshot
 * migrations. Consumers must use these values instead of maintaining their
 * own copies; the raw SHA-256 pins cover the exact packaged JSON bytes.
 */
export const KCC20_SNAPSHOT_ARTIFACT_PINS = Object.freeze({
  bootstrap: Object.freeze({
    key: "KCC20SnapshotBootstrap.placeholder.json",
    contractName: "KCC20SnapshotBootstrap",
    artifactSha256:
      "5f0caea9818f5bd6110023a7f089a0d26f87d3fd0901cb52e24a32bd1853b302",
    scriptLength: 33718,
    stateStart: 1,
    stateLength: 405,
  }),
  controller: Object.freeze({
    key: "KCC20SnapshotController.placeholder.json",
    contractName: "KCC20SnapshotController",
    artifactSha256:
      "8c5d2056bb0a445ffc1a6967238fac46378372b5f357524c6795201699bf2b2f",
    scriptLength: 15297,
    stateStart: 1,
    stateLength: 432,
  }),
});

/** Canonical KCC20 template committed by both snapshot contracts. */
export const KCC20_SNAPSHOT_TOKEN_TEMPLATE_PIN = Object.freeze({
  hash: "5d6cacdf57c734536fcb8a9c833f0318671226727ec77c503a98fc5be59f9e29",
  prefixLength: 1,
  suffixLength: 25264,
});

export type Kcc20ArtifactKey = keyof typeof KCC20_ARTIFACT_SCRIPT_SHA256;

export function isKcc20ArtifactKey(value: string): value is Kcc20ArtifactKey {
  return Object.prototype.hasOwnProperty.call(
    KCC20_ARTIFACT_SCRIPT_SHA256,
    value,
  );
}

export function assertKcc20ArtifactScriptHash(
  key: Kcc20ArtifactKey,
  artifact: unknown,
): void {
  const script = (artifact as { script?: unknown } | null)?.script;
  const bytes =
    script instanceof Uint8Array
      ? script
      : Array.isArray(script) &&
          script.every(
            (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff,
          )
        ? Uint8Array.from(script)
        : null;
  if (!bytes) {
    throw new Kcc20BuilderError(
      "ARTIFACT_MISMATCH",
      `contract artifact script is invalid for ${key}`,
      { artifactKey: key },
    );
  }
  const actualHash = [...sha256(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const expectedHash = KCC20_ARTIFACT_SCRIPT_SHA256[key];
  if (actualHash !== expectedHash) {
    throw new Kcc20BuilderError(
      "ARTIFACT_MISMATCH",
      `contract artifact hash mismatch for ${key}`,
      { artifactKey: key, expectedHash, actualHash },
    );
  }
}

export function requireArtifact(
  context: BuildContext,
  key: string,
): ArtifactDescriptor {
  const artifact = context.artifacts[key];
  if (!artifact) {
    throw new Kcc20BuilderError(
      "ARTIFACT_MISMATCH",
      `required contract artifact is missing: ${key}`,
      { artifactKey: key },
    );
  }
  return artifact;
}

export function assertArtifactHash(
  artifact: ArtifactDescriptor,
  expectedHash: string,
): void {
  if (artifact.hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Kcc20BuilderError(
      "ARTIFACT_MISMATCH",
      `contract artifact hash mismatch for ${artifact.key}`,
      { artifactKey: artifact.key, expectedHash, actualHash: artifact.hash },
    );
  }
}
