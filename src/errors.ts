export type Kcc20BuilderErrorCode =
  | "INVALID_INPUT"
  | "MISSING_SOURCE"
  | "STALE_SOURCE"
  | "ARTIFACT_MISMATCH"
  | "UNSUPPORTED_OPERATION"
  | "WASM_CAPABILITY_MISSING"
  | "SERIALIZATION_FAILED";

export class Kcc20BuilderError extends Error {
  readonly code: Kcc20BuilderErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: Kcc20BuilderErrorCode,
    message: string,
    details: Record<string, string> = {},
  ) {
    super(message);
    this.name = "Kcc20BuilderError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function requireHex64(value: string, label: string): string {
  const normalized = value.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Kcc20BuilderError(
      "INVALID_INPUT",
      `${label} must be 32-byte hex`,
    );
  }
  return normalized;
}
