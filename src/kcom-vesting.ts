// @ts-nocheck
import { sha256 } from "@noble/hashes/sha256";
import {
  buildKcc20ScriptForState,
  buildKcc20TransferSigScript,
  dispatchTagFor,
  normalizeSilverScriptArtifact,
  ownerAuthorizationWitness,
  templateParts,
  signedI64Payload,
  pushExplicit,
  concatBytes,
} from "./abi.js";
import { assertKcc20ArtifactScriptHash } from "./artifacts.js";
import {
  bytesToHex,
  hexToBytes,
  requireHex32,
  selectFundingEntry,
  utxoAmountSompi,
  setVersionOneInputMassFields,
} from "./sale-common.js";
export const KCOM_VESTING_ABI_SHA256 =
  "c041dc0012f22390f1f66fd09c6cc02eadb8865f496684c96e22ed690004d9f0";
export const KCOM_VESTING_KEYS = [
  "kcom-vesting.deploy",
  "kcom-vesting.release",
  "kcom-vesting.finish",
] as const;
export function kcomVestingCodec(raw) {
  if (
    bytesToHex(
      sha256(new TextEncoder().encode(JSON.stringify(raw?.sil_abi))),
    ) !== KCOM_VESTING_ABI_SHA256
  )
    throw new Error("KCOM vesting ABI/artifact pin mismatch");
  const abi = raw.sil_abi,
    normalized = normalizeSilverScriptArtifact(abi),
    fields = abi.contracts.KCOMVesting.runtime_state.fields,
    parts = templateParts(abi);
  function validate(s) {
    if (
      !s ||
      Object.keys(s).length !== fields.length ||
      fields.some((f) => !(f.name in s))
    )
      throw new Error("Exact vesting ABI state required");
    for (const f of fields) {
      const v = s[f.name];
      if (f.type.kind === "fixed_bytes") requireHex32(v, f.name);
      else if (
        (typeof v === "number" && !Number.isSafeInteger(v)) ||
        !/^(0|[1-9]\d*)$/.test(String(v)) ||
        BigInt(v) > 9223372036854775807n
      )
        throw new Error(`Invalid ${f.name}`);
    }
    if (
      BigInt(s.total) <= 0n ||
      BigInt(s.released) >= BigInt(s.total) ||
      ![1, 2, 3].includes(Number(s.tier)) ||
      Number(s.beneficiary_scheme) > 4 ||
      BigInt(s.tge_ms) < 500000000000n ||
      BigInt(s.tge_ms) > 9000000000000000n
    )
      throw new Error("Invalid vesting state");
  }
  function script(s) {
    validate(s);
    const payload = concatBytes(
      ...fields.map((f) =>
        pushExplicit(
          f.type.kind === "fixed_bytes"
            ? hexToBytes(s[f.name])
            : f.type.kind === "byte"
              ? Uint8Array.of(Number(s[f.name]))
              : signedI64Payload(BigInt(s[f.name])),
        ),
      ),
    );
    if (payload.length !== normalized.state_layout.len)
      throw new Error("Vesting state width mismatch");
    return concatBytes(parts.prefix, payload, parts.suffix);
  }
  function availability(s, time) {
    validate(s);
    const now = BigInt(time),
      tge = BigInt(s.tge_ms),
      tier = Number(s.tier),
      periods = tier === 3 ? 36n : 18n,
      first = tier === 1 ? 1n : tier === 2 ? 6n : 10n,
      total = BigInt(s.total),
      upfront =
        (total * (tier === 1 ? 1000n : tier === 2 ? 500n : 0n)) / 10000n;
    let completed = 0n,
      vested = 0n;
    if (now >= tge) {
      const elapsed = (now - tge) / 2592000000n;
      completed =
        elapsed < first
          ? 0n
          : elapsed - first + 1n > periods
            ? periods
            : elapsed - first + 1n;
      vested = upfront + ((total - upfront) * completed) / periods;
    }
    return {
      completed,
      vested,
      releasable: vested > BigInt(s.released) ? vested - BigInt(s.released) : 0n,
      remaining: total - BigInt(s.released),
      nextTrancheMs:
        now < tge && upfront > BigInt(s.released)
          ? String(tge)
          : completed < periods
          ? String(tge + (first + completed) * 2592000000n)
          : null,
    };
  }
  return { validate, script, availability, artifactId: raw.id, normalized };
}
export function createKcomVestingPsktBuilder(options) {
  const kw = options.wasm,
    config = options.config ?? {};
  const load = async (key) =>
    options.artifacts?.[key] ?? (await options.artifactProvider?.(key));
  return async (input) => {
    if (input.schema !== "kcc20-in-process-pskt-builder-input/v1")
      throw new Error("Invalid builder input schema");
    const req = input.request ?? {},
      p = req.params ?? {},
      network = req.network;
    if (network !== "testnet-10") throw new Error("KCOM vesting is TN10-only");
    const key = req.builderKey;
    if (!KCOM_VESTING_KEYS.includes(key))
      throw new Error("Unsupported vesting operation");
    const codec = kcomVestingCodec(await load("KCOMVesting.artifact.json")),
      state = p.state;
    codec.validate(state);
    const canonical = normalizeSilverScriptArtifact(
      await load("KCC20.placeholder.json"),
    );
    assertKcc20ArtifactScriptHash("KCC20.placeholder.json", canonical);
    const parts = templateParts(canonical);
    if (
      state.token_template_hash !== bytesToHex(parts.hash) ||
      BigInt(state.token_prefix_len) !== BigInt(parts.prefix.length) ||
      BigInt(state.token_suffix_len) !== BigInt(parts.suffix.length)
    )
      throw new Error("Canonical token template mismatch");
    const address = req.owner?.walletAddress;
    if (typeof address !== "string" || !address.startsWith("kaspatest:"))
      throw new Error("TN10 funding wallet required");
    const rpc =
      options.rpcClientFactory?.({
        url:
          config.KASPA_WRPC_URL ||
          "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
        encoding: kw.Encoding.Borsh,
        networkId: network,
      }) ??
      new kw.RpcClient({
        url:
          config.KASPA_WRPC_URL ||
          "wss://tn10-node.kaspa.com/kaspa/testnet-10/wrpc/borsh",
        encoding: kw.Encoding.Borsh,
        networkId: network,
      });
    const timed = (promise) => {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Vesting RPC timeout")),
            20000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
    };
    const query = async (a) =>
      (await timed(rpc.getUtxosByAddresses([a]))).entries;
    const spk = (script) => kw.payToScriptHashScript(script);
    const scriptAddress = (script) =>
      kw.addressFromScriptPublicKey(spk(script), network).toString();
    const refId = (entry) =>
      String(entry.entry?.covenantId ?? entry.covenantId ?? "");
    async function live(script, ref, id) {
      if (!ref || !Number.isSafeInteger(ref.index) || ref.index < 0)
        throw new Error("Source outpoint required");
      requireHex32(ref.transactionId, "source transaction");
      const e = (await query(scriptAddress(script))).find(
        (e) =>
          String(e.outpoint.transactionId) === ref.transactionId &&
          e.outpoint.index === ref.index,
      );
      if (!e || refId(e) !== id)
        throw new Error(
          "VESTING_SOURCE_STALE: rebuild from current covenant UTXO",
        );
      return e;
    }
    await timed(rpc.connect());
    try {
      const now =
          BigInt((await timed(rpc.getBlockDagInfo())).pastMedianTime) - 1n,
        fee = 60000000n,
        cell = 200000000n;
      const posScript = codec.script(state),
        inputs = [],
        outputs = [];
      let signingIndex,
        positionId = null,
        positionOutputIndex = null,
        releaseRaw = null;
      const fundingEntry = selectFundingEntry(
        (await query(address)).filter(
          (e) =>
            !refId(e) &&
            ![p.position, p.reserve].some(
              (r) =>
                r &&
                String(e.outpoint.transactionId) === r.transactionId &&
                e.outpoint.index === r.index,
            ),
        ),
        cell + fee + 10000n,
      );
      if (key === "kcom-vesting.deploy") {
        if (BigInt(state.released) !== 0n)
          throw new Error("Initial position must have released=0");
        inputs.push({
          previousOutpoint: fundingEntry.outpoint,
          utxo: fundingEntry,
          sequence: 0n,
          computeBudget: 300,
          sigOpCount: 0,
        });
        outputs.push(
          new kw.TransactionOutput(cell, spk(posScript)),
          new kw.TransactionOutput(
            utxoAmountSompi(fundingEntry) - cell - fee,
            kw.payToAddressScript(address),
          ),
        );
        signingIndex = 0;
        positionOutputIndex = 0;
      } else {
        positionId = requireHex32(p.positionId, "position id");
        const pe = await live(posScript, p.position, positionId),
          r = p.reserve,
          tokenState = {
            amount: BigInt(r?.state?.amount ?? "-1"),
            owner: hexToBytes(requireHex32(r?.state?.owner, "reserve owner")),
            ownerScheme: Number(r?.state?.ownerScheme),
            borrowScheme: Number(r?.state?.borrowScheme),
            borrowGuard: hexToBytes(
              requireHex32(r?.state?.borrowGuard, "borrow guard"),
            ),
            extensionCommitment: hexToBytes(
              requireHex32(r?.state?.extensionCommitment, "extension"),
            ),
          };
        if (
          tokenState.ownerScheme !== 4 ||
          bytesToHex(tokenState.owner) !== positionId ||
          tokenState.amount !== BigInt(state.total) - BigInt(state.released) ||
          tokenState.borrowScheme !== 0 ||
          bytesToHex(tokenState.borrowGuard) !== "00".repeat(32) ||
          bytesToHex(tokenState.extensionCommitment) !== state.extension
        )
          throw new Error("Invalid vesting token reserve");
        const tokenScript = buildKcc20ScriptForState(canonical, tokenState),
          te = await live(tokenScript, r, state.token_id),
          available = codec.availability(state, now);
        const amount =
            p.amountRaw === undefined
              ? available.releasable
              : BigInt(p.amountRaw),
          finish = amount === available.remaining;
        if (
          amount <= 0n ||
          amount > available.releasable ||
          finish !== (key === "kcom-vesting.finish")
        )
          throw new Error(
            "VESTING_NOT_RELEASABLE: amount or entrypoint unavailable",
          );
        const recipient = {
            ...tokenState,
            amount,
            owner: hexToBytes(state.beneficiary),
            ownerScheme: Number(state.beneficiary_scheme),
          },
          nextStates = finish
            ? [recipient]
            : [
                recipient,
                { ...tokenState, amount: tokenState.amount - amount },
              ];
        for (const [i, s] of nextStates.entries())
          outputs.push(
            new kw.TransactionOutput(
              finish
                ? utxoAmountSompi(pe) + utxoAmountSompi(te)
                : i === 0
                  ? cell
                  : utxoAmountSompi(te),
              spk(buildKcc20ScriptForState(canonical, s)),
              new kw.CovenantBinding(1, new kw.Hash(state.token_id)),
            ),
          );
        if (!finish) {
          positionOutputIndex = 2;
          outputs.push(
            new kw.TransactionOutput(
              utxoAmountSompi(pe),
              spk(
                codec.script({
                  ...state,
                  released: String(BigInt(state.released) + amount),
                }),
              ),
              new kw.CovenantBinding(0, new kw.Hash(positionId)),
            ),
          );
        }
        outputs.push(
          new kw.TransactionOutput(
            utxoAmountSompi(fundingEntry) - (finish ? fee : cell + fee),
            kw.payToAddressScript(address),
          ),
        );
        inputs.push(
          ...[pe, te, fundingEntry].map((e, i) => ({
            previousOutpoint: e.outpoint,
            utxo: e,
            sequence: 0n,
            computeBudget: i === 2 ? 300 : 2000,
            sigOpCount: 0,
          })),
        );
        signingIndex = 2;
        releaseRaw = String(amount);
        const b = new kw.ScriptBuilder();
        b.addI64(available.completed);
        if (!finish) b.addI64(amount);
        b.addI64(1n);
        b.addI64(0n);
        if (!finish) b.addI64(1n);
        b.addData(parts.prefix);
        b.addData(parts.suffix);
        b.addData(
          dispatchTagFor(codec.normalized, finish ? "finish" : "release"),
        );
        inputs[0].signatureScript = kw.ScriptBuilder.fromScript(
          posScript,
        ).encodePayToScriptHashSignatureScript(b.drain());
        inputs[1].signatureScript = kw.ScriptBuilder.fromScript(
          tokenScript,
        ).encodePayToScriptHashSignatureScript(
          buildKcc20TransferSigScript(kw, canonical, {
            nextStates,
            witness: ownerAuthorizationWitness(new Uint8Array()),
          }),
        );
      }
      let tx = new kw.Transaction({
        version: 1,
        lockTime: key === "kcom-vesting.deploy" ? 0n : now,
        inputs,
        outputs,
        subnetworkId: "00".repeat(20),
        gas: 0n,
        payload: "",
      });
      if (key === "kcom-vesting.deploy") {
        setVersionOneInputMassFields(tx, 300);
        tx.populateGenesisCovenants([new kw.GenesisCovenantGroup(0, [0])]);
        tx.finalize();
        positionId = String(tx.outputs[0].covenant.covenantId);
      }
      if (options.transactionWithMinimumCalculatedFeeChange)
        tx = options.transactionWithMinimumCalculatedFeeChange(
          kw,
          tx,
          outputs.length - 1,
          network,
          key,
        );
      return {
        schema: "kcc20-in-process-pskt-builder-output/v1",
        psktTransactionJson: tx.serializeToSafeJSON(),
        signInputs: [{ index: signingIndex, sighashType: 1 }],
        submitTransactionSupported: true,
        metadata: {
          builderKey: key,
          contract: "KCOMVesting",
          network,
          artifactId: codec.artifactId,
          positionId,
          positionOutputIndex,
          state,
          releaseRaw,
          consensusTimeMs: String(now),
          beneficiary: state.beneficiary,
          positionClosed: key === "kcom-vesting.finish",
        },
      };
    } finally {
      await rpc.disconnect();
    }
  };
}
