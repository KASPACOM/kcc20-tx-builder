export const KCC20_FIXED_DECIMALS = 8;
export const KCC20_MAX_DECIMALS = KCC20_FIXED_DECIMALS;
export const KCC20_LEGACY_DECIMALS = 0;
export const KCC20_U64_MAX = (1n << 64n) - 1n;
export const KCC20_DISPLAY_AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
export const KCC20_POSITIVE_DISPLAY_AMOUNT_RE =
  /^(?:(?:[1-9]\d*)(?:\.\d+)?|0\.\d*[1-9]\d*)$/;

export function parseKcc20Decimals(value: unknown): number | null {
  const normalized =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof normalized === "number" &&
    Number.isInteger(normalized) &&
    normalized >= 0 &&
    normalized <= KCC20_MAX_DECIMALS
    ? normalized
    : null;
}

export function normalizeKcc20Decimals(value: unknown): number {
  return parseKcc20Decimals(value) ?? KCC20_LEGACY_DECIMALS;
}

export function kcc20DisplayScaleForDecimals(decimals: number): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > KCC20_MAX_DECIMALS
  ) {
    throw new Error(`unsupported KCC20 decimals ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

export function kcc20SupportedDisplayScales(): bigint[] {
  return Array.from({ length: KCC20_MAX_DECIMALS + 1 }, (_, decimals) =>
    kcc20DisplayScaleForDecimals(decimals),
  );
}

export function kcc20DecimalsFromDisplayScale(value: unknown): number | null {
  const raw =
    typeof value === "bigint" ||
    typeof value === "number" ||
    typeof value === "string"
      ? String(value).trim()
      : "";
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const scale = BigInt(raw);
  for (let decimals = 0; decimals <= KCC20_MAX_DECIMALS; decimals += 1) {
    if (scale === 10n ** BigInt(decimals)) return decimals;
  }
  return null;
}

export function isSupportedKcc20DisplayScale(value: unknown): boolean {
  return kcc20DecimalsFromDisplayScale(value) !== null;
}

export function parseKcc20DisplayAmountToBaseUnits(
  value: string,
  decimals: number,
  field: string,
  options: { allowZero?: boolean } = {},
): string {
  const raw = String(value ?? "").trim();
  if (!KCC20_DISPLAY_AMOUNT_RE.test(raw)) {
    throw new Error(`${field} must be a non-negative decimal token amount`);
  }
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > KCC20_MAX_DECIMALS
  ) {
    throw new Error(`${field} has unsupported token decimals`);
  }

  const [whole, fraction = ""] = raw.split(".");
  if (decimals === 0 && fraction.length > 0) {
    throw new Error(
      `${field} must be an unsigned integer string for legacy tokens`,
    );
  }
  if (fraction.length > decimals) {
    throw new Error(`${field} supports at most ${decimals} decimal places`);
  }

  const scale = kcc20DisplayScaleForDecimals(decimals);
  const base =
    BigInt(whole) * scale +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (!options.allowZero && base <= 0n) {
    throw new Error(`${field} must be greater than zero`);
  }
  if (base > KCC20_U64_MAX) {
    throw new Error(`${field} exceeds u64 max`);
  }
  return base.toString();
}

export function formatKcc20BaseUnitsForDisplay(
  value: string,
  decimals: number,
): string {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return value;
  if (decimals <= 0) return raw;
  const scale = 10n ** BigInt(decimals);
  const amount = BigInt(raw);
  const whole = amount / scale;
  const fraction = (amount % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export interface Kcc20OrderTotalSompi {
  tokenAmountBaseUnits: string;
  roundedTokenAmountBaseUnits: string;
  totalSompi: string;
  roundedDown: boolean;
}

/** Gross KAS value for an indexed fill amount expressed in token base units. */
export function calculateKcc20FillTotalSompi(
  tokenAmountBaseUnits: unknown,
  unitPriceSompi: unknown,
  decimals: number = KCC20_FIXED_DECIMALS,
): string | undefined {
  const amount = parseUnsigned(tokenAmountBaseUnits);
  const price = parseUnsigned(unitPriceSompi);
  if (amount === undefined || amount <= 0n || price === undefined) {
    return undefined;
  }
  const scale = kcc20DisplayScaleForDecimals(normalizeKcc20Decimals(decimals));
  return ((amount * price) / scale).toString();
}

/**
 * Exact-sompi order calculation. Amount is rounded down to the nearest token
 * base-unit step whose product with unit price is divisible by price scale.
 */
export function calculateKcc20OrderTotalSompi(
  tokenAmount: string,
  unitPriceSompi: string,
  decimals: number,
): Kcc20OrderTotalSompi | undefined {
  let baseUnits: bigint;
  try {
    baseUnits = BigInt(
      parseKcc20DisplayAmountToBaseUnits(
        tokenAmount,
        normalizeKcc20Decimals(decimals),
        "tokenAmount",
      ),
    );
  } catch {
    return undefined;
  }
  const price = parseUnsigned(unitPriceSompi);
  if (price === undefined || price <= 0n) return undefined;

  const priceScale = kcc20DisplayScaleForDecimals(
    normalizeKcc20Decimals(decimals),
  );
  const step = priceScale / gcd(priceScale, price);
  const roundedBaseUnits = baseUnits - (baseUnits % step);
  if (roundedBaseUnits <= 0n) return undefined;

  return {
    tokenAmountBaseUnits: baseUnits.toString(),
    roundedTokenAmountBaseUnits: roundedBaseUnits.toString(),
    totalSompi: ((roundedBaseUnits * price) / priceScale).toString(),
    roundedDown: roundedBaseUnits !== baseUnits,
  };
}

export function requirePositiveU64(value: unknown, field: string): string {
  const raw = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${field} must be greater than zero`);
  }
  if (BigInt(raw) > KCC20_U64_MAX) {
    throw new Error(`${field} exceeds u64 max`);
  }
  return raw;
}

export function normalizeKcc20OwnerIdentifier(
  value: string,
  field = "owner",
): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (/^[a-f0-9]{64}$/.test(normalized)) {
    return normalized;
  }
  const decoded = ownerFromKaspaAddress(normalized);
  if (decoded) return decoded;
  throw new Error(`${field} must be a 64 hex owner or Kaspa P2PK address`);
}

const KASPA_ADDRESS_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const KASPA_ADDRESS_GENERATORS = [
  0x98f2bc8e61n,
  0x79b76d99e2n,
  0xf33e5fb3c4n,
  0xae2eabe2a8n,
  0x1e4f43e470n,
];

function ownerFromKaspaAddress(value: string): string | undefined {
  const [prefix, payload, extra] = value.split(":");
  if (!prefix || !payload || extra !== undefined) return undefined;
  const data: number[] = [];
  for (const char of payload) {
    const index = KASPA_ADDRESS_CHARSET.indexOf(char);
    if (index < 0) return undefined;
    data.push(index);
  }
  if (
    data.length <= 8 ||
    kaspaAddressPolymod(kaspaAddressPrefixExpand(prefix).concat(data)) !== 1n
  ) {
    return undefined;
  }
  const bytes = convertBits(data.slice(0, -8), 5, 8, false);
  if (!bytes || bytes.length !== 33 || (bytes[0] !== 0 && bytes[0] !== 1)) {
    return undefined;
  }
  return bytes
    .slice(1)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function kaspaAddressPrefixExpand(prefix: string): number[] {
  return [...prefix].map((char) => char.charCodeAt(0) & 0x1f).concat([0]);
}

function kaspaAddressPolymod(values: number[]): bigint {
  let checksum = 1n;
  for (const value of values) {
    const top = checksum >> 35n;
    checksum = ((checksum & 0x07ffffffffn) << 5n) ^ BigInt(value);
    for (let index = 0; index < KASPA_ADDRESS_GENERATORS.length; index += 1) {
      if (((top >> BigInt(index)) & 1n) === 1n) {
        checksum ^= KASPA_ADDRESS_GENERATORS[index];
      }
    }
  }
  return checksum;
}

function convertBits(
  data: number[],
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] | undefined {
  let accumulator = 0;
  let bits = 0;
  const result: number[] = [];
  const maxValue = (1 << toBits) - 1;
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits) return undefined;
    accumulator = ((accumulator << fromBits) | value) & maxAccumulator;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >> bits) & maxValue);
    }
  }
  if (pad && bits > 0) {
    result.push((accumulator << (toBits - bits)) & maxValue);
  } else if (
    !pad &&
    (bits >= fromBits || ((accumulator << (toBits - bits)) & maxValue) !== 0)
  ) {
    return undefined;
  }
  return result;
}

function parseUnsigned(value: unknown): bigint | undefined {
  const raw = String(value ?? "").trim();
  return /^\d+$/.test(raw) ? BigInt(raw) : undefined;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}
