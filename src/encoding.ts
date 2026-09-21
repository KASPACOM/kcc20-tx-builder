import { Kcc20BuilderError } from "./errors.js";

export function hexToBytes(value: string, label = "hex value"): Uint8Array {
  const hex = value.trim().replace(/^0x/i, "");
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) {
    throw new Kcc20BuilderError(
      "INVALID_INPUT",
      `${label} must be an even-length hexadecimal string`,
    );
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function requireHex(value: string, byteLength: number, label: string) {
  const bytes = hexToBytes(value, label);
  if (bytes.length !== byteLength) {
    throw new Kcc20BuilderError(
      "INVALID_INPUT",
      `${label} must be ${byteLength} bytes`,
    );
  }
  return bytesToHex(bytes);
}

export function asciiToBytes32(value: string, label = "value"): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > 32) {
    throw new Kcc20BuilderError(
      "INVALID_INPUT",
      `${label} must be at most 32 UTF-8 bytes`,
    );
  }
  const result = new Uint8Array(32);
  result.set(encoded);
  return result;
}

export function concatByteArrays(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
