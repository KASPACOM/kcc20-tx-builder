import { Kcc20BuilderError } from "./errors.js";
import type { ArtifactDescriptor, BuildContext } from "./models.js";
import { sha256 } from "@noble/hashes/sha256";

/** The only native KCC20 artifact used to build new transactions. */
export const KCC20_CURRENT_NATIVE_ARTIFACT_KEY =
  "KCC20.placeholder.json" as const;

export const KCC20_ARTIFACT_SCRIPT_SHA256 = Object.freeze({
  "KCC20SnapshotBootstrap.placeholder.json": "85edea7401eb415c447e6a0d0a45e1667802a269dde9fbe33d5881c4a4de51e2",
  "KCC20SnapshotController.placeholder.json": "8f90525afcc1c23240f1d18eed30b3b377a72a323e8b48925dfac53bd5aab0ae",
  [KCC20_CURRENT_NATIVE_ARTIFACT_KEY]:
    "4633b082f26adbf14600b767d6e2146e36ce67d63d8202c0281857922c05ac41",
  "KCC20FeeTicket.placeholder.json":
    "ed81365466ee4c44db1210b3360783af8145f74e49e847848195e09c71ad6930",
  "KCC20Orderbook.placeholder.json":
    "ef9fe81ff7aa2dc2df118d8d7cc126aca6f2f9c181b9c2d15727a538b23c6f71",
  "KCC20Wrapper.placeholder.json":
    "f3bdf09be9aa258708a306283a4278a93cfb64f35fc50ed7d316b9b189ef9030",
  "KCC20Vesting.placeholder.json":
    "1b84d74aa01b6a50edbff5bf1f9e988a5a6a00ec645458dfd3912ac532b77c33",
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
      "bc566a964b5feb1c2055d5130af25951142d695472287b888c5537e9a56ee3d2",
    scriptLength: 33718,
    stateStart: 1,
    stateLength: 405,
  }),
  controller: Object.freeze({
    key: "KCC20SnapshotController.placeholder.json",
    contractName: "KCC20SnapshotController",
    artifactSha256:
      "f0d7b082e0680a90736948cd6658ccbc8600e097d9b4d5568013acdaafb39bf5",
    scriptLength: 15297,
    stateStart: 1,
    stateLength: 432,
  }),
});

/** Canonical KCC20 template committed by both snapshot contracts. */
export const KCC20_SNAPSHOT_TOKEN_TEMPLATE_PIN = Object.freeze({
  hash: "911f0638ccb7368bf36d117f1725073ae7ee487ce8b58ca3e8375051c2d40f6c",
  prefixLength: 1,
  suffixLength: 25439,
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
