import { Kcc20BuilderError } from "./errors.js";
import type { ArtifactDescriptor, BuildContext } from "./models.js";
import { sha256 } from "@noble/hashes/sha256";

export const KCC20_ARTIFACT_SCRIPT_SHA256 = Object.freeze({
  "KCC20.placeholder.json":
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
