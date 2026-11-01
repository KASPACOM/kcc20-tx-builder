import { Kcc20BuilderError } from "./errors.js";
import type { ArtifactDescriptor, BuildContext } from "./models.js";
import { sha256 } from "@noble/hashes/sha256";

/** The only native KCC20 artifact used to build new transactions. */
export const KCC20_CURRENT_NATIVE_ARTIFACT_KEY =
  "KCC20.placeholder.json" as const;

export const KCC20_ARTIFACT_SCRIPT_SHA256 = Object.freeze({
  "KCC20SnapshotBootstrap.placeholder.json":
    "a22b93b0d8cd04096d83d25bbb6c38f0c07ac025b70226677db484fa93fe09ef",
  "KCC20SnapshotController.placeholder.json":
    "8a73c57e309860ff799a71ca9352afa84f71638061cfa427cc5e8d36d1b8b025",
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
  "KCC20FeeEscrowV1.placeholder.json":
    "90ff237d0c9d18a896ebea6ae048611805e434b85d2909050bf8dd07c4056133",
  "KCC20FeeRecipientV1.placeholder.json":
    "13cad3943dc79e80bbd73b3b2fb139be55f8d0eabd16439b7b3aee4ed763b336",
  "KCC20OrderbookFeeRootV1.placeholder.json":
    "c05643e79c1c1a56c46f7c175c1f4e7adaedb8727364d50efe76c6bde70eb610",
  "KCC20OrderbookFeeHolderV1.placeholder.json":
    "0d3de762cd5528526bd99443b73bfd66eaba2ce252a8b7789022965b691bb8d8",
  "KCC20OrderbookFeeAskV1.placeholder.json":
    "a87e25c0c66d206bc31f33d79094f5b31177f1dd261804b071ad7bc3b3b6b8b5",
  "KCC20OrderbookFeeBidV1.placeholder.json":
    "9289b3b5fcd46f30af4f236c65f76f369bd856311319474d20e06c5ba919ea8f",
  "KCC20WrapperFeeV1.placeholder.json":
    "53338a33d4e57964ff76ffe2c95e25786995f7c1f96f9375b57bcac3c124d3ba",
  "KCC20WrapperFeeArgentV1.placeholder.json":
    "b7ebdf13e66a10407c36e56a24f9f91a0db27602508eb2a297da613d1c43cdbd",
});

/** Raw file pins cover the ABI and dispatch tags as well as the script bytes. */
export const KCC20_FEE_V1_ARTIFACT_SHA256 = Object.freeze({
  "KCC20FeeEscrowV1.placeholder.json": "40aeb72a858bd3e20143e8686226dd66df191745d990a4afd8e22ea1cc643bdf",
  "KCC20FeeRecipientV1.placeholder.json": "06944587b4055ee61050707c35e3774bee82f1c6e37914b0f14c6d7fdaf5ab71",
  "KCC20OrderbookFeeRootV1.placeholder.json": "25f28f56285bda070d4a6fa6a4733e7c3cf5eebee44531990b6f4c5a9ab254a8",
  "KCC20OrderbookFeeHolderV1.placeholder.json": "1124365e746ebe108fe8e5a9a7d13ea351bba0768011fd3228567d35de0847d1",
  "KCC20OrderbookFeeAskV1.placeholder.json": "e2f04e79a64acf330ae45ad55bab61f92039c76d1c59e4d9b39d41b1c3296553",
  "KCC20OrderbookFeeBidV1.placeholder.json": "4a6150291bb9e459a4ca61609854af7063c5f7314e0f5c2438a7f462627d33d4",
  "KCC20WrapperFeeV1.placeholder.json": "345cbefc8f870b2daa408e2608c4fcf50d27d9f5ebb505439ee22092715f0007",
  "KCC20WrapperFeeArgentV1.placeholder.json": "d14cdd05f9522b393e9b5e674a4645cf6b51f8831a5bb370882eb0e9a2f8d4b0",
});

export const KCC20_FEE_V1_POLICY_MANIFEST_SHA256 =
  "b2c41a428d0ef68cbcb37606ef569e8ec57d2aa3add9e0f78daccc3eba9ed80a";

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
      "daddabe50454e1c6c187c0b027cc8887f79f0f0086a14f26c6a2a56054991ebb",
    scriptLength: 35913,
    stateStart: 1,
    stateLength: 414,
  }),
  controller: Object.freeze({
    key: "KCC20SnapshotController.placeholder.json",
    contractName: "KCC20SnapshotController",
    artifactSha256:
      "a73727cfe03108097e1226566cff9dbbbf42a5dc8526aac3196817ffc642212f",
    scriptLength: 15350,
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
