/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-unused-vars */
// @ts-nocheck
import {
  buildKcc20ScriptForState as buildStandardKcc20ScriptForState,
  dispatchTag,
} from "./abi.js";
import {
  DEFAULT_COMPUTE_BUDGET,
  DEFAULT_KCC20_FEE_BPS,
  DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI,
  DEFAULT_KCC20_PRICE_SCALE,
  DEFAULT_KCC20_TOKEN_DECIMALS,
  DEFAULT_TOKEN_OUTPUT_SOMPI,
  KCC20_ORDERBOOK_EXPANDED_SWEEP_OUTPUT_SOMPI,
  KCC20_ORDERBOOK_MAX_EXPANDED_SWEEP_BID_LEGS,
  KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS,
  KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT,
  KCC20_PLATFORM_PROTOCOL_FEE_RECIPIENT,
  SOMPI_PER_TKAS,
  SUBNETWORK_ID_NATIVE,
  ZERO_HASH,
} from "./protocol.js";

export {
  DEFAULT_COMPUTE_BUDGET,
  DEFAULT_KCC20_FEE_BPS,
  DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI,
  DEFAULT_KCC20_PRICE_SCALE,
  DEFAULT_KCC20_TOKEN_DECIMALS,
  DEFAULT_TOKEN_OUTPUT_SOMPI,
  KCC20_ORDERBOOK_EXPANDED_SWEEP_OUTPUT_SOMPI,
  KCC20_ORDERBOOK_MAX_EXPANDED_SWEEP_BID_LEGS,
  KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS,
  KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT,
  KCC20_PLATFORM_PROTOCOL_FEE_RECIPIENT,
  SOMPI_PER_TKAS,
  SUBNETWORK_ID_NATIVE,
  ZERO_HASH,
} from "./protocol.js";

export const DEFAULT_FEE = 50_000n;
export const DEFAULT_KCC20_MIN_GROSS_FILL_SOMPI = 50_000_000n;

export function kcc20PsktBuilderError(message, code, details = {}) {
  const error = new Error(message);
  error.builderErrorCode = code;
  error.builderErrorDetails = Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
  return error;
}

const WRAPPED_ACTION_TAGS = Object.freeze({
  unwrapByOwnerSig: kcc1Tag("unwrapByOwnerSig(byte[],int,int,int,int)"),
  createBidFromRoot: kcc1Tag("createBidFromRoot(byte[32],int,int,int,int)"),
  createAskByOwnerSig: kcc1Tag("createAskByOwnerSig(byte[],int,int,int,int)"),
  fillAskPartial: kcc1Tag("fillAskPartial(byte[32],int,int,int,int,int)"),
  fillBidPartial: kcc1Tag("fillBidPartial(int,int,int,int,int,pubkey,int)"),
  sellIntoBidByOwnerSig: kcc1Tag(
    "sellIntoBidByOwnerSig(byte[],byte[32],int,int,int,int,int)",
  ),
  crossAskSide: kcc1Tag(
    "crossAskSide(byte[32],int,int,int,int,int,int,int,int,int,int)",
  ),
  crossBidSide: kcc1Tag(
    "crossBidSide(int,int,int,int,int,int,int,int,int,pubkey,int)",
  ),
  cancelAskByOwnerSig: kcc1Tag("cancelAskByOwnerSig(byte[],int)"),
  cancelBidByOwnerSig: kcc1Tag("cancelBidByOwnerSig(byte[],int)"),
  mergeByOwnerSig: kcc1Tag("mergeByOwnerSig(byte[])"),
  mergePeerByOwnerSig: kcc1Tag("mergePeerByOwnerSig(byte[],int,int)"),
  fillBidFromSellerSweep: kcc1Tag(
    "fillBidFromSellerSweep(int,int,int,int,int,int,pubkey,int)",
  ),
  sellIntoBidsByOwnerSig: kcc1Tag(
    "sellIntoBidsByOwnerSig(byte[],byte[32],int,int,byte[32],int,int,byte[32],int,int,int,int,int)",
  ),
  sellIntoBids10ByOwnerSig: kcc1Tag(
    "sellIntoBids10ByOwnerSig(byte[],byte[32],int,int,byte[32],int,int,byte[32],int,int,byte[32],int,int,byte[32],int,int,byte[32],int,int,byte[32],int,int,byte[32],int,int,byte[32],int,int,byte[32],int,int,int,int,int)",
  ),
});

function kcc1Tag(signature) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/.exec(signature);
  if (!match) throw new Error(`invalid KCC1 signature ${signature}`);
  const inputs = match[2]
    ? match[2].split(",").map((type_name) => ({ type_name }))
    : [];
  return dispatchTag({ name: match[1], inputs });
}

export function parseArgs(argv) {
  const map = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      map.flags.add(a);
    } else {
      map[a.slice(2)] = next;
      i++;
    }
  }
  return map;
}

export function parseTokenDecimalsArg(args) {
  if (args["token-decimals"] == null) return null;
  const raw = String(args["token-decimals"]).trim();
  if (!/^\d+$/.test(raw))
    throw new Error(`invalid --token-decimals ${args["token-decimals"]}`);
  const decimals = Number(raw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    throw new Error(`invalid --token-decimals ${args["token-decimals"]}`);
  }
  return decimals;
}

export function resolveKcc20TokenDecimals(args, ...values) {
  const explicitDecimals = parseTokenDecimalsArg(args);
  if (explicitDecimals != null) return explicitDecimals;
  return values.some((value) => String(value ?? "").includes("."))
    ? DEFAULT_KCC20_TOKEN_DECIMALS
    : 0;
}

export function parseKcc20TokenAmount(
  value,
  label = "token amount",
  decimals = 0,
) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`missing ${label}`);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    throw new Error(`${label} must be a non-negative decimal amount`);
  }
  const [whole, fraction = ""] = raw.split(".");
  if (decimals === 0 && fraction.length > 0) {
    throw new Error(`${label} requires --token-decimals for fractional input`);
  }
  if (fraction.length > decimals) {
    throw new Error(`${label} supports at most ${decimals} decimal places`);
  }
  const scale = 10n ** BigInt(decimals);
  return (
    BigInt(whole) * scale +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0")
  );
}

export function parseKcc20TokenAmountArg(args, key, fallback, label = key) {
  const raw = args[key] ?? fallback;
  const decimals = resolveKcc20TokenDecimals(args, raw);
  return parseKcc20TokenAmount(raw, label, decimals);
}

export function resolveKcc20PriceScale(
  args,
  fallback = DEFAULT_KCC20_PRICE_SCALE,
) {
  if (args["price-scale"] != null) {
    const raw = String(args["price-scale"]).trim();
    if (!/^[1-9]\d*$/.test(raw))
      throw new Error(`invalid --price-scale ${args["price-scale"]}`);
    return BigInt(raw);
  }
  const decimals = parseTokenDecimalsArg(args);
  if (decimals != null) return 10n ** BigInt(decimals);
  return BigInt(fallback);
}

export function requireHex32(value, label) {
  const clean = String(value || "")
    .trim()
    .replace(/^0x/i, "")
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`${label} must be 32-byte hex, got: ${value}`);
  }
  return clean;
}

export function identifierTypeName(t) {
  if (t === 0) return "p2pk-schnorr/v1";
  if (t === 1) return "p2pkh-schnorr/v1";
  if (t === 2) return "p2pkh-ecdsa/v1";
  if (t === 3) return "p2sh/v1";
  if (t === 4) return "covenant-id/v1";
  return "unknown";
}

export function parseMintPolicy(value) {
  const raw = String(value).trim().toLowerCase();
  if (
    raw === "0" ||
    raw === "holder" ||
    raw === "fixed" ||
    raw === "fixed-supply" ||
    raw === "fixedsupply"
  )
    return 0;
  if (
    raw === "1" ||
    raw === "controlled" ||
    raw === "controlled-mint" ||
    raw === "controlledmint"
  )
    return 1;
  if (
    raw === "2" ||
    raw === "public" ||
    raw === "public-mint" ||
    raw === "publicmint"
  )
    return 2;
  throw new Error(`invalid KCC20 mint policy: ${value}`);
}

export function mintPolicyName(mode) {
  if (mode === 0) return "fixed";
  if (mode === 1) return "controlled";
  if (mode === 2) return "public";
  return "unknown";
}

export function hexToBytes(hex) {
  const clean = String(hex).trim().replace(/^0x/i, "");
  if (!/^(?:[0-9a-f]{2})*$/i.test(clean)) {
    throw new Error(`invalid even-length hex value: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function asciiToBytes32(value, label) {
  const clean = String(value || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!/^[\x20-\x7E]*$/.test(clean)) {
    throw new Error(`${label} must be printable ASCII`);
  }
  const encoded = new TextEncoder().encode(clean);
  if (encoded.length > 32) {
    throw new Error(`${label} must be 32 bytes or fewer`);
  }
  const out = new Uint8Array(32);
  out.set(encoded);
  return out;
}

export function bytes32ToAscii(bytes) {
  const arr = Uint8Array.from(bytes || []);
  const end = arr.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? arr.slice(0, end) : arr).trimEnd();
}

export function writeI64LE(value) {
  let n = BigInt(value);
  if (n > 9_223_372_036_854_775_807n) {
    throw new Error(`amount exceeds signed i64 range: ${value}`);
  }
  if (n < 0n) {
    n = (1n << 64n) + n;
  }
  const out = new Uint8Array(8);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

export function readI64LE(bytes) {
  if (bytes.length !== 8) {
    throw new Error(`readI64LE expected 8 bytes, got ${bytes.length}`);
  }
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) {
    n |= BigInt(bytes[i]) << BigInt(8 * i);
  }
  if (n & (1n << 63n)) {
    n -= 1n << 64n;
  }
  return n;
}

export function normalizeSignature(bytes) {
  if (bytes.length === 66 && bytes[0] === 65) {
    return bytes.slice(1);
  }
  if (bytes.length !== 65) {
    throw new Error(
      `expected 65-byte Schnorr signature+sighash, got ${bytes.length}`,
    );
  }
  return bytes;
}

export function patchRange(target, start, end, replacement) {
  if (replacement.length !== end - start) {
    throw new Error(
      `patch length mismatch for ${start}..${end}: ${replacement.length}`,
    );
  }
  target.set(replacement, start);
}

export function buildNativeKcc20ScriptForState(baseScript, state) {
  return buildStandardKcc20ScriptForState(
    { bytecode: Array.from(baseScript), state_layout: { start: 1, len: 112 } },
    {
      amount: BigInt(state.amount),
      owner: state.ownerIdentifier || state.owner,
      ownerScheme: Number(state.identifierType ?? state.ownerScheme ?? 0),
      borrowScheme: Number(state.borrowScheme ?? 0),
      borrowGuard: state.borrowGuard || hexToBytes(ZERO_HASH),
      extensionCommitment: state.extensionCommitment,
    },
  );
}

export function buildKcc20V3ScriptForState(baseScript, state) {
  const script = Uint8Array.from(baseScript);
  patchRange(script, 2, 34, state.ownerIdentifier);
  expectPushLen(script, 34, 8, "amount");
  patchRange(script, 35, 43, writeI64LE(state.amount));
  expectPushLen(script, 43, 8, "mode");
  patchRange(script, 44, 52, writeI64LE(BigInt(state.mode)));
  expectPushLen(script, 52, 8, "unitPriceSompi");
  patchRange(script, 53, 61, writeI64LE(state.unitPriceSompi));
  return script;
}

export function buildApiPaymentChannelScriptForState(baseScript, state) {
  const script = Uint8Array.from(baseScript);
  patchRange(script, 2, 34, hexToBytes(state.payerPubkey));
  patchRange(script, 35, 67, hexToBytes(state.providerPubkey));
  patchRange(script, 68, 100, hexToBytes(state.providerPayoutPubkey));
  patchRange(script, 101, 133, hexToBytes(state.voucherDomainHash));
  patchRange(script, 134, 142, writeI64LE(state.refundAfterMs));
  patchRange(script, 143, 151, writeI64LE(state.reserveSompi));
  patchRange(script, 152, 160, writeI64LE(state.maxSpendSompi));
  patchRange(script, 161, 169, writeI64LE(state.closeAfterMs || 0n));
  return script;
}

export function buildKcc20OrderbookScriptForState(baseScript, state) {
  if (!state.canonicalTokenId)
    throw new Error("KCC20Orderbook state missing canonicalTokenId");
  const priceScale = requireSupportedKcc20DisplayScale(
    state.priceScale ?? DEFAULT_KCC20_PRICE_SCALE,
    "KCC20Orderbook priceScale",
  );
  const script = Uint8Array.from(baseScript);
  expectPushLen(script, 1, 32, "canonicalTokenId");
  patchRange(script, 2, 34, state.canonicalTokenId);
  expectPushLen(script, 34, 32, "ownerIdentifier");
  patchRange(script, 35, 67, state.ownerIdentifier);
  expectPushLen(script, 67, 1, "ownerScheme");
  patchRange(
    script,
    68,
    69,
    Uint8Array.of(Number(state.ownerScheme ?? state.identifierType ?? 0)),
  );
  expectPushLen(script, 69, 8, "amount");
  patchRange(script, 70, 78, writeI64LE(state.amount));
  expectPushLen(script, 78, 8, "mode");
  patchRange(script, 79, 87, writeI64LE(BigInt(state.mode)));
  expectPushLen(script, 87, 8, "unitPriceSompi");
  patchRange(script, 88, 96, writeI64LE(state.unitPriceSompi));
  expectPushLen(script, 96, 32, "feeTicketId");
  patchRange(script, 97, 129, state.feeTicketId || hexToBytes(ZERO_HASH));
  expectPushLen(script, 129, 8, "priceScale");
  patchRange(script, 130, 138, writeI64LE(priceScale));
  return script;
}

export function buildKcc20FeeTicketScriptForState(baseScript, state) {
  const script = Uint8Array.from(baseScript);
  patchRange(script, 2, 34, state.ownerIdentifier);
  expectPushLen(script, 34, 1, "ownerScheme");
  patchRange(
    script,
    35,
    36,
    Uint8Array.of(Number(state.ownerScheme ?? state.identifierType ?? 0)),
  );
  expectPushLen(script, 36, 8, "mode");
  patchRange(script, 37, 45, writeI64LE(BigInt(state.mode)));
  expectPushLen(script, 45, 32, "utilityTokenId");
  patchRange(script, 46, 78, state.utilityTokenId);
  expectPushLen(script, 78, 8, "denomination");
  patchRange(script, 79, 87, writeI64LE(BigInt(state.denomination)));
  return script;
}

export function buildKcc20VestingScriptForState(baseScript, state) {
  const script = Uint8Array.from(baseScript);
  expectPushLen(script, 1, 32, "canonicalTokenId");
  patchRange(script, 2, 34, state.canonicalTokenId);
  expectPushLen(script, 34, 32, "beneficiary");
  patchRange(script, 35, 67, state.beneficiary);
  expectPushLen(script, 67, 1, "beneficiaryScheme");
  patchRange(
    script,
    68,
    69,
    Uint8Array.of(
      Number(state.beneficiaryScheme ?? state.beneficiaryType ?? 0),
    ),
  );
  expectPushLen(script, 69, 8, "unlockTimeMs");
  patchRange(script, 70, 78, writeI64LE(BigInt(state.unlockTimeMs)));
  return script;
}

export function buildKaspaFomoRoundScript(baseScript, state, recipients = {}) {
  const script = buildKaspaFomoRoundScriptForState(baseScript, state);
  if (recipients.roundSigner) {
    const signer = hexToBytes(
      requireHex32(recipients.roundSigner, "round signer"),
    );
    patchRange(script, 118, 150, signer);
    patchRange(script, 357, 389, signer);
  }
  if (recipients.marketingRecipient) {
    patchRange(
      script,
      537,
      569,
      hexToBytes(
        requireHex32(recipients.marketingRecipient, "marketing recipient"),
      ),
    );
  }
  if (recipients.platformRecipient) {
    patchRange(
      script,
      599,
      631,
      hexToBytes(
        requireHex32(recipients.platformRecipient, "platform recipient"),
      ),
    );
  }
  return script;
}

export function buildKaspaFomoRoundScriptForState(baseScript, state) {
  const script = Uint8Array.from(baseScript);
  patchRange(
    script,
    2,
    34,
    hexToBytes(requireHex32(state.lastBuyer, "last buyer")),
  );
  expectPushLen(script, 34, 8, "endTimeMs");
  patchRange(script, 35, 43, writeI64LE(BigInt(state.endTimeMs)));
  expectPushLen(script, 43, 8, "ticketCount");
  patchRange(script, 44, 52, writeI64LE(BigInt(state.ticketCount)));
  return script;
}

export function readKaspaFomoRoundState(script) {
  const bytes = Uint8Array.from(script);
  expectPushLen(bytes, 1, 32, "lastBuyer");
  expectPushLen(bytes, 34, 8, "endTimeMs");
  expectPushLen(bytes, 43, 8, "ticketCount");
  return {
    lastBuyer: bytesToHex(bytes.slice(2, 34)),
    endTimeMs: readI64LE(bytes.slice(35, 43)),
    ticketCount: readI64LE(bytes.slice(44, 52)),
  };
}

export function buildKcc20WrapperScriptForState(baseScript, state) {
  const script = Uint8Array.from(baseScript);
  patchRange(script, 2, 34, state.canonicalTokenId);
  if (script[34] !== 1) {
    throw new Error(
      `unsupported KCC20Wrapper enabled push length ${script[34]}; expected 1`,
    );
  }
  script[35] = state.enabled ? 1 : 0;
  expectPushLen(script, 36, 8, "priceScale");
  patchRange(
    script,
    37,
    45,
    writeI64LE(
      requireSupportedKcc20DisplayScale(
        state.priceScale ?? DEFAULT_KCC20_PRICE_SCALE,
        "KCC20Wrapper priceScale",
      ),
    ),
  );
  return script;
}

function kcc20DecimalsFromDisplayScale(value) {
  const scale = BigInt(value);
  for (let decimals = 0; decimals <= 8; decimals += 1) {
    if (10n ** BigInt(decimals) === scale) return decimals;
  }
  return null;
}

function kcc20DisplayScaleForDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    throw new Error(`unsupported KCC20 decimals: ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

function requireSupportedKcc20DisplayScale(value, label) {
  const decimals = kcc20DecimalsFromDisplayScale(value);
  if (decimals === null) {
    throw new Error(
      `${label} must be an exact power-of-ten display scale for decimals 0-8`,
    );
  }
  return kcc20DisplayScaleForDecimals(decimals);
}

export function orderbookModeName(mode) {
  if (Number(mode) === 0) return "holder";
  if (Number(mode) === 1) return "root";
  if (Number(mode) === 2) return "ask";
  if (Number(mode) === 3) return "bid";
  return "unknown";
}

export function stateToReceiptFields(state) {
  const amount = BigInt(state.amount).toString();
  const owner = state.ownerIdentifier || state.owner;
  const ownerScheme = Number(state.ownerScheme ?? state.identifierType ?? 0);
  return {
    owner: bytesToHex(owner),
    ownerScheme,
    ownerSchemeName: identifierTypeName(ownerScheme),
    borrowScheme: Number(state.borrowScheme ?? 0),
    borrowGuard: bytesToHex(state.borrowGuard || hexToBytes(ZERO_HASH)),
    extensionCommitment: bytesToHex(state.extensionCommitment),
    tokenAmount: amount,
    stateAmount: amount,
    balance: amount,
    amount,
    isMintAuthority: amount === "0",
  };
}

export function stateToV3ReceiptFields(state) {
  const owner = bytesToHex(state.ownerIdentifier);
  const amount = BigInt(state.amount).toString();
  const unitPrice = BigInt(state.unitPriceSompi).toString();
  const priceScale = BigInt(
    state.priceScale ?? DEFAULT_KCC20_PRICE_SCALE,
  ).toString();
  const mode = Number(state.mode);
  const ownerScheme = Number(state.ownerScheme ?? state.identifierType ?? 0);
  const feeRecipient = KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT;
  const fields = {
    ownerIdentifier: owner,
    stateOwner: owner,
    ownerScheme,
    ownerSchemeName: identifierTypeName(ownerScheme),
    tokenAmount: amount,
    stateAmount: amount,
    amount,
    mode,
    stateMode: mode,
    modeName: orderbookModeName(mode),
    unitPriceSompi: unitPrice,
    marketUnitPriceSompi: unitPrice,
    priceScale,
    tokenDisplayScale: priceScale,
    minGrossFillSompi: DEFAULT_KCC20_MIN_GROSS_FILL_SOMPI.toString(),
    minProtocolFeeSompi: DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI.toString(),
    feeRecipient,
    protocolFeeRecipient: feeRecipient,
    feeBps: Number(DEFAULT_KCC20_FEE_BPS),
    protocolFeeBps: Number(DEFAULT_KCC20_FEE_BPS),
    feeTicketId: state.feeTicketId ? bytesToHex(state.feeTicketId) : ZERO_HASH,
  };
  if (state.canonicalTokenId) {
    fields.canonicalTokenId = bytesToHex(state.canonicalTokenId);
    fields.tokenId = fields.canonicalTokenId;
  }
  return fields;
}

export function receiptToKcc20OrderbookState(receipt, fallbackOwnerHex) {
  const state = {
    ownerIdentifier: hexToBytes(
      requireHex32(
        receipt.stateOwner || receipt.ownerIdentifier || fallbackOwnerHex,
        "state owner",
      ),
    ),
    ownerScheme: Number(
      receipt.ownerScheme ??
        receipt.stateOwnerType ??
        receipt.identifierType ??
        0,
    ),
    amount: BigInt(
      receipt.stateAmount || receipt.tokenAmount || receipt.amount || "0",
    ),
    mode: Number(receipt.stateMode ?? receipt.mode ?? 0),
    unitPriceSompi: BigInt(
      receipt.marketUnitPriceSompi || receipt.unitPriceSompi || "0",
    ),
    priceScale: BigInt(
      receipt.tokenDisplayScale ||
        receipt.priceScale ||
        DEFAULT_KCC20_PRICE_SCALE,
    ),
    feeRecipient: hexToBytes(KCC20_ORDERBOOK_PROTOCOL_FEE_RECIPIENT),
    feeBps: Number(DEFAULT_KCC20_FEE_BPS),
    feeTicketId: hexToBytes(
      requireHex32(receipt.feeTicketId || ZERO_HASH, "fee ticket id"),
    ),
  };
  if (receipt.canonicalTokenId || receipt.tokenId) {
    state.canonicalTokenId = hexToBytes(
      requireHex32(
        receipt.canonicalTokenId || receipt.tokenId,
        "canonical token id",
      ),
    );
  }
  return state;
}

export function buildKcc20V3IssueSigScript(
  kw,
  { signature, toOwner, tokenAmount, tokenOutputIndex, rootOutputIndex },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(signature);
  builder.addData(toOwner);
  builder.addI64(BigInt(tokenAmount));
  builder.addI64(BigInt(tokenOutputIndex));
  builder.addI64(BigInt(rootOutputIndex));
  builder.addI64(0n);
  return builder.drain();
}

export function buildKcc20V3CreateBidSigScript(
  kw,
  { buyer, bidAmount, unitPriceSompi, bidOutputIndex, rootOutputIndex },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(buyer);
  builder.addI64(BigInt(bidAmount));
  builder.addI64(BigInt(unitPriceSompi));
  builder.addI64(BigInt(bidOutputIndex));
  builder.addI64(BigInt(rootOutputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.createBidFromRoot);
  return builder.drain();
}

export function buildKcc20V3CreateAskSigScript(
  kw,
  { signature, askAmount, unitPriceSompi, askOutputIndex, changeOutputIndex },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(signature);
  builder.addI64(BigInt(askAmount));
  builder.addI64(BigInt(unitPriceSompi));
  builder.addI64(BigInt(askOutputIndex));
  builder.addI64(BigInt(changeOutputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.createAskByOwnerSig);
  return builder.drain();
}

export function buildKcc20V3FillAskSigScript(
  kw,
  {
    buyerOwner,
    fillAmount,
    buyerTokenOutputIndex,
    askOutputIndex,
    sellerOutputIndex,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(buyerOwner);
  builder.addI64(BigInt(fillAmount));
  builder.addI64(BigInt(buyerTokenOutputIndex));
  builder.addI64(BigInt(askOutputIndex));
  builder.addI64(BigInt(sellerOutputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.fillAskPartial);
  return builder.drain();
}

export function buildKcc20OrderbookFillAskSigScript(
  kw,
  {
    buyerOwner,
    fillAmount,
    buyerTokenOutputIndex,
    askOutputIndex,
    sellerOutputIndex,
    ticketInputIndex = -1,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(buyerOwner);
  builder.addI64(BigInt(fillAmount));
  builder.addI64(BigInt(buyerTokenOutputIndex));
  builder.addI64(BigInt(askOutputIndex));
  builder.addI64(BigInt(sellerOutputIndex));
  builder.addI64(BigInt(ticketInputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.fillAskPartial);
  return builder.drain();
}

export function buildKcc20V3FillBidSigScript(
  kw,
  {
    sellerTokenInputIndex,
    fillAmount,
    buyerTokenOutputIndex,
    bidOutputIndex,
    sellerOutputIndex,
    seller,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addI64(BigInt(sellerTokenInputIndex));
  builder.addI64(BigInt(fillAmount));
  builder.addI64(BigInt(buyerTokenOutputIndex));
  builder.addI64(BigInt(bidOutputIndex));
  builder.addI64(BigInt(sellerOutputIndex));
  builder.addData(seller);
  builder.addData(WRAPPED_ACTION_TAGS.fillBidPartial);
  return builder.drain();
}

export function buildKcc20OrderbookFillBidSigScript(
  kw,
  {
    sellerTokenInputIndex,
    fillAmount,
    buyerTokenOutputIndex,
    bidOutputIndex,
    sellerOutputIndex,
    seller,
    ticketInputIndex = -1,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addI64(BigInt(sellerTokenInputIndex));
  builder.addI64(BigInt(fillAmount));
  builder.addI64(BigInt(buyerTokenOutputIndex));
  builder.addI64(BigInt(bidOutputIndex));
  builder.addI64(BigInt(sellerOutputIndex));
  builder.addData(seller);
  builder.addI64(BigInt(ticketInputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.fillBidPartial);
  return builder.drain();
}

export function buildKcc20V3SellIntoBidSigScript(
  kw,
  {
    signature,
    buyerOwner,
    fillAmount,
    buyerTokenOutputIndex,
    sellerChangeOutputIndex,
    sellerRefundOutputIndex = -1,
    sellerOutputsEndIndex = -1,
    takesRefundOutput = false,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(signature);
  builder.addData(buyerOwner);
  builder.addI64(BigInt(fillAmount));
  builder.addI64(BigInt(buyerTokenOutputIndex));
  builder.addI64(BigInt(sellerChangeOutputIndex));
  if (takesRefundOutput) {
    builder.addI64(BigInt(sellerRefundOutputIndex));
    builder.addI64(BigInt(sellerOutputsEndIndex));
  }
  builder.addData(WRAPPED_ACTION_TAGS.sellIntoBidByOwnerSig);
  return builder.drain();
}

export function buildKcc20OrderbookCrossAskSigScript(
  kw,
  {
    buyerOwner,
    bidInputIndex,
    fillAmount,
    clearingUnitPriceSompi,
    buyerTokenOutputIndex,
    askOutputIndex,
    bidOutputIndex,
    sellerOutputIndex,
    feeOutputIndex,
    refundOutputIndex,
    ticketInputIndex = -1,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(buyerOwner);
  builder.addI64(BigInt(bidInputIndex));
  builder.addI64(BigInt(fillAmount));
  builder.addI64(BigInt(clearingUnitPriceSompi));
  builder.addI64(BigInt(buyerTokenOutputIndex));
  builder.addI64(BigInt(askOutputIndex));
  builder.addI64(BigInt(bidOutputIndex));
  builder.addI64(BigInt(sellerOutputIndex));
  builder.addI64(BigInt(feeOutputIndex));
  builder.addI64(BigInt(refundOutputIndex));
  builder.addI64(BigInt(ticketInputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.crossAskSide);
  return builder.drain();
}

export function buildKcc20OrderbookCrossAskLegacySigScript(
  kw,
  {
    buyerOwner,
    bidInputIndex,
    fillAmount,
    clearingUnitPriceSompi,
    buyerTokenOutputIndex,
    askOutputIndex,
    bidOutputIndex,
    sellerOutputIndex,
    feeOutputIndex,
    refundOutputIndex,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(buyerOwner);
  builder.addI64(BigInt(bidInputIndex));
  builder.addI64(BigInt(fillAmount));
  builder.addI64(BigInt(clearingUnitPriceSompi));
  builder.addI64(BigInt(buyerTokenOutputIndex));
  builder.addI64(BigInt(askOutputIndex));
  builder.addI64(BigInt(bidOutputIndex));
  builder.addI64(BigInt(sellerOutputIndex));
  builder.addI64(BigInt(feeOutputIndex));
  builder.addI64(BigInt(refundOutputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.crossAskSide);
  return builder.drain();
}

export function buildKcc20OrderbookCrossBidSigScript(
  kw,
  {
    askInputIndex,
    fillAmount,
    clearingUnitPriceSompi,
    buyerTokenOutputIndex,
    askOutputIndex,
    bidOutputIndex,
    sellerOutputIndex,
    feeOutputIndex,
    refundOutputIndex,
    seller,
    ticketInputIndex = -1,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addI64(BigInt(askInputIndex));
  builder.addI64(BigInt(fillAmount));
  builder.addI64(BigInt(clearingUnitPriceSompi));
  builder.addI64(BigInt(buyerTokenOutputIndex));
  builder.addI64(BigInt(askOutputIndex));
  builder.addI64(BigInt(bidOutputIndex));
  builder.addI64(BigInt(sellerOutputIndex));
  builder.addI64(BigInt(feeOutputIndex));
  builder.addI64(BigInt(refundOutputIndex));
  builder.addData(seller);
  builder.addI64(BigInt(ticketInputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.crossBidSide);
  return builder.drain();
}

export function buildKcc20OrderbookCrossBidLegacySigScript(
  kw,
  {
    askInputIndex,
    fillAmount,
    clearingUnitPriceSompi,
    buyerTokenOutputIndex,
    askOutputIndex,
    bidOutputIndex,
    sellerOutputIndex,
    feeOutputIndex,
    refundOutputIndex,
    seller,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addI64(BigInt(askInputIndex));
  builder.addI64(BigInt(fillAmount));
  builder.addI64(BigInt(clearingUnitPriceSompi));
  builder.addI64(BigInt(buyerTokenOutputIndex));
  builder.addI64(BigInt(askOutputIndex));
  builder.addI64(BigInt(bidOutputIndex));
  builder.addI64(BigInt(sellerOutputIndex));
  builder.addI64(BigInt(feeOutputIndex));
  builder.addI64(BigInt(refundOutputIndex));
  builder.addData(seller);
  builder.addData(WRAPPED_ACTION_TAGS.crossBidSide);
  return builder.drain();
}

export function buildKcc20OrderbookCancelAskSigScript(
  kw,
  { signature, holderOutputIndex },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(signature);
  builder.addI64(BigInt(holderOutputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.cancelAskByOwnerSig);
  return builder.drain();
}

export function buildKcc20OrderbookCancelBidSigScript(
  kw,
  { signature, refundOutputIndex },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(signature);
  builder.addI64(BigInt(refundOutputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.cancelBidByOwnerSig);
  return builder.drain();
}

export function buildKcc20OrderbookMergePrimarySigScript(kw, { signature }) {
  const builder = new kw.ScriptBuilder();
  builder.addData(signature);
  builder.addData(WRAPPED_ACTION_TAGS.mergeByOwnerSig);
  return builder.drain();
}

export function buildKcc20OrderbookMergePeerSigScript(
  kw,
  { signature, primaryInputIndex, mergedAmount },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(signature);
  builder.addI64(BigInt(primaryInputIndex));
  builder.addI64(BigInt(mergedAmount));
  builder.addData(WRAPPED_ACTION_TAGS.mergePeerByOwnerSig);
  return builder.drain();
}

export function buildKcc20OrderbookFillBidFromSellerSweepSigScript(
  kw,
  {
    sellerTokenInputIndex,
    sellerAuthOutputOrdinal,
    fillAmount,
    buyerTokenOutputIndex,
    bidOutputIndex,
    sellerOutputIndex,
    seller,
    ticketInputIndex = -1,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addI64(BigInt(sellerTokenInputIndex));
  builder.addI64(BigInt(sellerAuthOutputOrdinal));
  builder.addI64(BigInt(fillAmount));
  builder.addI64(BigInt(buyerTokenOutputIndex));
  builder.addI64(BigInt(bidOutputIndex));
  builder.addI64(BigInt(sellerOutputIndex));
  builder.addData(seller);
  builder.addI64(BigInt(ticketInputIndex));
  builder.addData(WRAPPED_ACTION_TAGS.fillBidFromSellerSweep);
  return builder.drain();
}

export function buildKcc20OrderbookSellIntoBidsSigScript(
  kw,
  {
    signature,
    legs,
    changeOutputIndex,
    sellerRefundOutputIndex = -1,
    sellerOutputsEndIndex = -1,
    takesRefundOutput = false,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(signature);
  for (let i = 0; i < KCC20_ORDERBOOK_MAX_SWEEP_BID_LEGS; i++) {
    const leg = legs[i] || {};
    builder.addData(leg.buyerOwner || hexToBytes(ZERO_HASH));
    builder.addI64(BigInt(leg.fillAmount || 0n));
    builder.addI64(BigInt(leg.buyerTokenOutputIndex ?? -1));
  }
  builder.addI64(BigInt(changeOutputIndex));
  if (takesRefundOutput) {
    builder.addI64(BigInt(sellerRefundOutputIndex));
    builder.addI64(BigInt(sellerOutputsEndIndex));
  }
  builder.addData(WRAPPED_ACTION_TAGS.sellIntoBidsByOwnerSig);
  return builder.drain();
}

export function buildKcc20OrderbookSellIntoBids10SigScript(
  kw,
  {
    signature,
    legs,
    changeOutputIndex,
    sellerRefundOutputIndex = -1,
    sellerOutputsEndIndex = -1,
    takesRefundOutput = false,
  },
) {
  const builder = new kw.ScriptBuilder();
  builder.addData(signature);
  for (let i = 0; i < KCC20_ORDERBOOK_MAX_EXPANDED_SWEEP_BID_LEGS; i++) {
    const leg = legs[i] || {};
    builder.addData(leg.buyerOwner || hexToBytes(ZERO_HASH));
    builder.addI64(BigInt(leg.fillAmount || 0n));
    builder.addI64(BigInt(leg.buyerTokenOutputIndex ?? -1));
  }
  builder.addI64(BigInt(changeOutputIndex));
  if (takesRefundOutput) {
    builder.addI64(BigInt(sellerRefundOutputIndex));
    builder.addI64(BigInt(sellerOutputsEndIndex));
  }
  builder.addData(WRAPPED_ACTION_TAGS.sellIntoBids10ByOwnerSig);
  return builder.drain();
}

export function argByteArray(hex) {
  const values = hexToBytes(hex);
  return {
    kind: "array",
    data: {
      type_ref: {
        base: "byte",
        array_dims: [{ kind: "fixed", value: values.length }],
      },
      values: Array.from(values, (b) => ({ kind: "byte", data: b })),
    },
  };
}

export function argByte(value) {
  return { kind: "byte", data: Number(value) };
}

export function argInt(value) {
  const n = BigInt(value);
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `SilverScript int constructor arg is outside JS safe integer range: ${value}`,
    );
  }
  return { kind: "int", data: Number(n) };
}

export function argBool(value) {
  return { kind: "bool", data: Boolean(value) };
}

export function p2pkScriptPubKey(kw, pubkeyHex) {
  return new kw.ScriptPublicKey(0, `20${requireHex32(pubkeyHex, "pubkey")}ac`);
}

export function p2shScriptHashHex(kw, script) {
  const spk = kw.payToScriptHashScript(script);
  const hex = String(spk.script);
  if (!/^aa20[0-9a-f]{64}87$/i.test(hex)) {
    throw new Error(`unexpected P2SH script public key: ${hex}`);
  }
  return hex.slice(4, 68).toLowerCase();
}

export function calculateFeeSplit(grossSompi, feeBps = DEFAULT_KCC20_FEE_BPS) {
  const gross = BigInt(grossSompi);
  const fee = calculateFeeSompi(gross, feeBps);
  return { fee, net: gross - fee };
}

export function exactGrossSompi(
  rawAmount,
  unitPriceSompi,
  priceScale = DEFAULT_KCC20_PRICE_SCALE,
) {
  const raw = BigInt(rawAmount);
  const price = BigInt(unitPriceSompi);
  const scale = BigInt(priceScale ?? DEFAULT_KCC20_PRICE_SCALE);
  if (raw < 0n || price < 0n || scale <= 0n)
    throw new Error("invalid exact gross inputs");
  const whole = raw / scale;
  const fraction = raw - whole * scale;
  const fractionProduct = fraction * price;
  if (fractionProduct % scale !== 0n) {
    throw new Error(
      `gross value is not an exact sompi amount for raw=${raw} unitPriceSompi=${price} priceScale=${scale}`,
    );
  }
  return whole * price + fractionProduct / scale;
}

export function calculateFeeSompi(grossSompi, feeBps = DEFAULT_KCC20_FEE_BPS) {
  const gross = BigInt(grossSompi);
  const bps = BigInt(feeBps);
  if (gross < 0n)
    throw new Error(`grossSompi must be non-negative: ${grossSompi}`);
  if (bps < 0n || bps > 10_000n)
    throw new Error(`feeBps must be 0..10000: ${feeBps}`);
  const percentageFee = (gross * bps) / 10_000n;
  return percentageFee < DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI
    ? DEFAULT_KCC20_MIN_PROTOCOL_FEE_SOMPI
    : percentageFee;
}

export function selectFundingEntry(
  entries,
  requiredSompi,
  skippedOutpoints = [],
) {
  const skipped = new Set(skippedOutpoints);
  const sorted = [...entries].sort((a, b) => {
    const av = utxoAmountSompi(a);
    const bv = utxoAmountSompi(b);
    if (av === bv) return 0;
    return av < bv ? 1 : -1;
  });
  const entry = sorted.find((candidate) => {
    const outpoint = `${candidate.outpoint?.transactionId}:${candidate.outpoint?.index}`;
    return (
      !skipped.has(outpoint) && utxoAmountSompi(candidate) >= requiredSompi
    );
  });
  if (!entry) {
    throw new Error(`no single funding UTXO can cover ${requiredSompi} sompi`);
  }
  return entry;
}

export function requiredToccataFeeSompi(kw, network, transaction) {
  if (
    typeof kw.calculateTransactionFee !== "function" ||
    typeof kw.calculateTransactionMass !== "function"
  ) {
    throw new Error("Kaspa transaction fee calculators are unavailable");
  }
  const calculatedFee = BigInt(
    kw.calculateTransactionFee(network, transaction, 1) || 0n,
  );
  const baseMass = BigInt(kw.calculateTransactionMass(network, transaction, 1));
  const computeBudget = [...transaction.inputs].reduce(
    (sum, input) => sum + BigInt(input.computeBudget || 0),
    0n,
  );
  const relayFee = (baseMass + computeBudget * 100n) * 100n;
  return relayFee > calculatedFee ? relayFee : calculatedFee;
}

export function utxoAmountSompi(entry) {
  const amount = entry?.amount ?? entry?.utxoEntry?.amount;
  if (amount === undefined || amount === null) {
    throw new Error("UTXO entry is missing amount");
  }
  return BigInt(amount);
}

export function findOutputIndex(
  tx,
  address,
  networkId,
  addressFromScriptPublicKey,
) {
  for (let i = 0; i < tx.outputs.length; i++) {
    const outputAddress = addressFromScriptPublicKey(
      tx.outputs[i].scriptPublicKey,
      networkId,
    )?.toString();
    if (outputAddress === address) return i;
  }
  return -1;
}

export function setVersionOneInputMassFields(tx, computeBudget = 30) {
  const inputs = tx.inputs;
  for (const input of inputs) {
    input.sigOpCount = 0;
    input.computeBudget = computeBudget;
  }
  tx.inputs = inputs;
}

export function extractLockedOutput(lockReceipt, saleCovenantId, tokenAmount) {
  const output = lockReceipt.outputs?.find(
    (candidate) =>
      candidate.ownerIdentifier === saleCovenantId &&
      Number(candidate.identifierType) === 4 &&
      BigInt(candidate.tokenAmount) === BigInt(tokenAmount),
  );
  if (!output) {
    throw new Error(
      `lock receipt does not contain ${tokenAmount} tokens owned by sale covenant ${saleCovenantId}`,
    );
  }
  if (!lockReceipt.txid) {
    throw new Error("lock receipt is missing submitted txid");
  }
  return {
    txid: lockReceipt.txid,
    vout: Number(output.vout),
    tokenAmount: BigInt(output.tokenAmount),
  };
}

function expectPushLen(script, offset, expected, label) {
  if (script[offset] !== expected) {
    throw new Error(
      `unsupported KCC20 ${label} push length ${script[offset]}; expected ${expected}`,
    );
  }
}
