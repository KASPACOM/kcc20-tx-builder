import {
  authenticateTokenArtifact,
  requireTokenCapability,
  resolveAuthenticatedTokenProfile,
  type AuthenticatedTokenProfileRegistry,
} from "./token-profiles.js";
import {
  buildKcc20ScriptForState,
  encodeKcc20StateRecordArrays,
} from "./abi.js";
import {
  planTokenOwnerWitness,
  buildTokenBorrowWitness,
  type TokenSigningCapabilities,
} from "./token-authorization.js";

export interface ProfileTokenState {
  amount: bigint;
  owner: Uint8Array;
  ownerScheme: number;
  borrowScheme: number;
  borrowGuard: Uint8Array;
  extensionCommitment: Uint8Array;
}
export interface ProfileTransferInput {
  /** A current, authenticated RPC UTXO. This API does not fetch chain state. */
  entry: any;
  state: ProfileTokenState;
  publicKey?: string;
  authorityInputIndex?: number;
}
export interface ProfileAuthorityInput {
  entry: any;
  revealScript: Uint8Array;
  /** Exact authority witness, supplied by its reviewed authority adapter. */
  arguments: Array<
    | { type: "data"; hex: string }
    | { type: "i64"; value: string }
    | { type: "signature"; prefixHex?: string }
  >;
  signatureAlgorithm?: "schnorr" | "ecdsa";
}
export interface ProfileTransferPlan {
  /** Host-authenticated registry input; never populate this from transaction request data. */
  tokenProfileRegistry: AuthenticatedTokenProfileRegistry;
  profileId: string;
  artifact: unknown;
  tokenInputs: ProfileTransferInput[];
  nextStates: ProfileTokenState[];
  authorities?: ProfileAuthorityInput[];
  fundingEntry: any;
  fundingAddress: string;
  feeSompi: bigint;
  network: string;
  tokenOutputSompi?: bigint;
  capabilities: TokenSigningCapabilities;
  mode: "owner" | "borrow";
  borrow?: {
    nextGuard?: string;
    oneTimePublicKey?: string;
    signingPublicKey?: string;
  };
}
const hex = (v: Uint8Array) =>
  Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
const amount = (e: any) =>
  BigInt(e.amount ?? e.entry?.amount ?? e.utxoEntry?.amount);
const spk = (e: any) =>
  e.scriptPublicKey ?? e.entry?.scriptPublicKey ?? e.utxoEntry?.scriptPublicKey;
const cid = (e: any): string | undefined => {
  const c = e.covenantId ?? e.entry?.covenantId ?? e.utxoEntry?.covenantId;
  return c == null ? undefined : String(c).toLowerCase();
};
const outpoint = (e: any) => e.outpoint ?? e.entry?.outpoint;
const assert = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};

/**
 * Deterministic standard transfer construction for explicit authority/borrow flows.
 * Callers authenticate RPC freshness and canonical acceptance before signing.
 * Authority continuations preserve their script, value and covenant identity.
 */
export function buildProfileTransferTransaction(
  kw: any,
  plan: ProfileTransferPlan,
): any {
  const profile = resolveAuthenticatedTokenProfile(
    plan.tokenProfileRegistry,
    plan.profileId,
  );
  const { tokenInputs, nextStates } = plan;
  requireTokenCapability(
    profile,
    plan.mode === "borrow" ? "borrow" : "transfer",
  );
  assert(
    plan.mode === "owner" || plan.mode === "borrow",
    "explicit owner or borrow mode is required",
  );
  const artifact = authenticateTokenArtifact(profile, plan.artifact);
  assert(
    tokenInputs.length > 0 && tokenInputs.length <= profile.maxTokenInputs,
    "token input bound exceeded",
  );
  assert(
    nextStates.length > 0 && nextStates.length <= profile.maxTokenOutputs,
    "token output bound exceeded",
  );
  assert(
    plan.feeSompi >= 0n && plan.feeSompi <= 50_000_000n,
    "fee exceeds transaction limit",
  );
  const tokenId = cid(tokenInputs[0].entry);
  assert(
    tokenId && /^[0-9a-f]{64}$/.test(tokenId),
    "native token identity is required",
  );
  const extension = hex(tokenInputs[0].state.extensionCommitment);
  let total = 0n;
  for (const input of tokenInputs) {
    assert(cid(input.entry) === tokenId, "mixed native token identities");
    assert(
      input.state.amount >= 0n &&
        hex(input.state.extensionCommitment) === extension,
      "invalid input amount or extension",
    );
    total += input.state.amount;
    const expected = kw.payToScriptHashScript(
      buildKcc20ScriptForState(artifact, input.state),
    );
    assert(
      kw.addressFromScriptPublicKey(expected, plan.network).toString() ===
        kw
          .addressFromScriptPublicKey(spk(input.entry), plan.network)
          .toString(),
      "token input script does not authenticate its state",
    );
  }
  assert(total <= 0x7fffffffffffffffn, "transfer total exceeds integer limit");
  for (const state of nextStates) {
    assert(
      state.amount >= 0n && hex(state.extensionCommitment) === extension,
      "invalid output amount or extension",
    );
    assert(
      profile.ownerSchemes.includes(state.ownerScheme) &&
        [0, 1, 2, 3].includes(state.borrowScheme),
      "unsupported output owner or borrow scheme",
    );
  }
  assert(
    nextStates.reduce((sum, s) => sum + s.amount, 0n) === total,
    "token conservation failed",
  );
  const authorities = plan.authorities ?? [];
  assert(
    authorities.length <= 255 - tokenInputs.length,
    "too many authority inputs",
  );
  const authorityEvidence = authorities.map((a, i) => {
    assert(
      a.revealScript.length > 0 && a.revealScript.length <= 100_000,
      "invalid authority reveal size",
    );
    const expected = kw.payToScriptHashScript(a.revealScript);
    assert(
      kw.addressFromScriptPublicKey(expected, plan.network).toString() ===
        kw.addressFromScriptPublicKey(spk(a.entry), plan.network).toString(),
      "authority reveal does not match its RPC output",
    );
    assert(
      cid(a.entry) !== tokenId,
      "token family inputs must be listed as token inputs",
    );
    assert(a.arguments.length <= 128, "authority witness exceeds limit");
    for (const arg of a.arguments) {
      assert(
        ["data", "i64", "signature"].includes(arg.type),
        "unsupported authority witness argument",
      );
      if (arg.type === "data")
        assert(
          /^(?:[a-f0-9]{2})*$/i.test(arg.hex) && arg.hex.length <= 200_000,
          "invalid authority witness data",
        );
      if (arg.type === "i64")
        assert(
          /^-?\d+$/.test(arg.value) &&
            BigInt(arg.value) >= -0x7fffffffffffffffn &&
            BigInt(arg.value) <= 0x7fffffffffffffffn,
          "invalid authority integer",
        );
      if (arg.type === "signature") {
        assert(
          a.signatureAlgorithm && plan.capabilities[a.signatureAlgorithm],
          "wallet cannot sign the authority scheme",
        );
        assert(
          /^(?:[a-f0-9]{2})*$/i.test(arg.prefixHex ?? ""),
          "invalid authority signature prefix",
        );
      }
    }
    return {
      index: tokenInputs.length + i,
      scriptPublicKeyHex: String(expected.script),
      covenantId: cid(a.entry),
    };
  });
  const entries = [
    ...tokenInputs.map((i) => i.entry),
    ...authorities.map((i) => i.entry),
    plan.fundingEntry,
  ];
  const keys = entries.map((e) => {
    const o = outpoint(e);
    assert(
      o &&
        /^[0-9a-f]{64}$/i.test(String(o.transactionId)) &&
        Number.isInteger(o.index) &&
        o.index >= 0,
      "invalid source outpoint",
    );
    return `${String(o.transactionId).toLowerCase()}:${o.index}`;
  });
  assert(new Set(keys).size === keys.length, "duplicate transaction input");
  assert(!cid(plan.fundingEntry), "funding input must not spend a covenant");
  assert(
    kw
      .addressFromScriptPublicKey(spk(plan.fundingEntry), plan.network)
      .toString() === plan.fundingAddress,
    "funding input does not belong to wallet",
  );
  const scripts: any[] = [];
  for (let index = 0; index < tokenInputs.length; index++) {
    const input = tokenInputs[index];
    let authorization: any;
    if (index === 0 && plan.mode === "borrow") {
      const previous = input.state,
        next = nextStates[0],
        borrow = plan.borrow ?? {};
      assert(previous.borrowScheme !== 0, "borrowing is disabled");
      assert(
        hex(previous.owner) === hex(next.owner) &&
          previous.ownerScheme === next.ownerScheme &&
          previous.borrowScheme === next.borrowScheme,
        "borrow successor changes ownership or scheme",
      );
      const delta = next.amount - previous.amount;
      let threshold = 0n;
      if (previous.borrowScheme === 1) {
        for (let i = 7; i >= 0; i--)
          threshold = (threshold << 8n) | BigInt(previous.borrowGuard[i]);
        assert(
          (threshold & (1n << 63n)) === 0n || threshold === 1n << 63n,
          "negative thresholds are not supported by this adapter",
        );
        if (threshold === 1n << 63n) threshold = 0n;
      }
      assert(delta > threshold, "borrow increase does not exceed threshold");
      if (previous.borrowScheme !== 3)
        assert(
          hex(previous.borrowGuard) === hex(next.borrowGuard),
          "borrow guard must be preserved",
        );
      else
        assert(
          hex(next.borrowGuard) === borrow.nextGuard,
          "borrow successor guard differs from committed next link",
        );
      if (previous.borrowScheme !== 1) {
        assert(
          plan.capabilities.schnorr,
          "wallet cannot sign borrowed receive",
        );
        assert(
          borrow.signingPublicKey ===
            (previous.borrowScheme === 2
              ? hex(previous.borrowGuard)
              : borrow.oneTimePublicKey),
          "borrow signing key does not match authorization",
        );
      }
      // Validate the complete witness shape/hash link before leaving a signature slot.
      const witness = buildTokenBorrowWitness({
        profile,
        borrowScheme: previous.borrowScheme,
        currentGuard: hex(previous.borrowGuard),
        ...(previous.borrowScheme === 1
          ? {}
          : {
              signature: "00".repeat(64) + "01",
              nextGuard: borrow.nextGuard,
              oneTimePublicKey: borrow.oneTimePublicKey,
            }),
      });
      authorization =
        previous.borrowScheme === 1
          ? { argument: { type: "data", hex: hex(witness) } }
          : {
              argument: {
                type: "signature",
                prefixHex: hex(witness.slice(0, -65)),
              },
              signatureAlgorithm: "schnorr",
            };
    } else {
      authorization = planTokenOwnerWitness({
        profile,
        owner: hex(input.state.owner),
        ownerScheme: input.state.ownerScheme,
        publicKey: input.publicKey,
        capabilities: plan.capabilities,
        role: index === 0 ? "leader" : "delegator",
        authorityInputIndex: input.authorityInputIndex,
        authorityInputs: authorityEvidence,
      });
    }
    scripts.push({
      inputIndex: index,
      scriptHex: hex(buildKcc20ScriptForState(artifact, input.state)),
      signType: 1,
      ...(authorization.signatureAlgorithm
        ? { signatureAlgorithm: authorization.signatureAlgorithm }
        : {}),
      signatureScript: {
        mode: "ordered-args",
        args: [
          ...(index === 0
            ? encodeKcc20StateRecordArrays(nextStates).map((v: Uint8Array) => ({
                type: "data",
                hex: hex(v),
              }))
            : []),
          authorization.argument,
          {
            type: "data",
            hex: index === 0 ? profile.transferTag : profile.delegatorTag,
          },
        ],
      },
    });
  }
  for (let i = 0; i < authorities.length; i++)
    scripts.push({
      inputIndex: tokenInputs.length + i,
      scriptHex: hex(authorities[i].revealScript),
      signType: 1,
      signatureAlgorithm: authorities[i].signatureAlgorithm,
      signatureScript: { mode: "ordered-args", args: authorities[i].arguments },
    });
  const tokenValue = plan.tokenOutputSompi ?? 50_000_000n;
  assert(tokenValue > 0n, "token output KAS must be positive");
  if (plan.mode === "borrow")
    assert(
      tokenValue >= amount(tokenInputs[0].entry),
      "borrow successor must preserve its KAS value",
    );
  const outputs = nextStates.map(
    (state) =>
      new kw.TransactionOutput(
        tokenValue,
        kw.payToScriptHashScript(buildKcc20ScriptForState(artifact, state)),
        new kw.CovenantBinding(0, new kw.Hash(tokenId)),
      ),
  );
  for (let i = 0; i < authorities.length; i++) {
    const entry = authorities[i].entry,
      identity = cid(entry);
    outputs.push(
      new kw.TransactionOutput(
        amount(entry),
        spk(entry),
        identity
          ? new kw.CovenantBinding(
              tokenInputs.length + i,
              new kw.Hash(identity),
            )
          : undefined,
      ),
    );
  }
  const change =
    entries.reduce((sum, e) => sum + amount(e), 0n) -
    BigInt(nextStates.length) * tokenValue -
    authorities.reduce((sum, a) => sum + amount(a.entry), 0n) -
    plan.feeSompi;
  assert(change > 10_000n, "insufficient funding or change");
  outputs.push(
    new kw.TransactionOutput(
      change,
      kw.payToAddressScript(plan.fundingAddress),
    ),
  );
  const transaction = new kw.Transaction({
    version: 1,
    lockTime: 0n,
    subnetworkId: "00".repeat(20),
    gas: 0n,
    payload: "",
    inputs: entries.map((e) => ({
      previousOutpoint: outpoint(e),
      utxo: e,
      sequence: 0n,
      sigOpCount: 0,
      computeBudget: 1000,
    })),
    outputs,
  });
  transaction.inputs[entries.length - 1].computeBudget = 30;
  return {
    schema: "kcc20-in-process-pskt-builder-output/v1",
    psktTransactionJson: transaction.serializeToSafeJSON(),
    scripts,
    signInputs: [{ index: entries.length - 1, sighashType: 1 }],
    submitTransactionSupported: true,
    metadata: {
      tokenProfileId: profile.id,
      covenantId: tokenId,
      mode: plan.mode,
      fundingChangeOutputIndex: outputs.length - 1,
    },
  };
}
