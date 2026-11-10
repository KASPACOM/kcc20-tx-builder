import type { Built, Runtime, ScriptHint } from "./build.ts";
function bytes(hex: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})*$/i.test(hex))
    throw new Error("Invalid hexadecimal script");
  return Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
}
function needsSignature(hint: ScriptHint): boolean {
  return hint.signatureScript?.mode !== "ordered-args" ||
    (hint.signatureScript.args ?? []).some(arg => arg.type === "signature");
}
// Some covenants are authorized by another input and need only ABI arguments.
export function signingInputs(result: Built, capabilities = { schnorr: true, ecdsa: false }) {
  const inputs = new Map(
    result.signInputs.map((input) => [input.index, input]),
  );
  for (const script of result.scripts ?? []) {
    if (!needsSignature(script)) continue;
    const algorithm = script.signatureAlgorithm ?? "schnorr";
    if (!capabilities[algorithm]) throw new Error(`Wallet does not support ${algorithm} signatures`);
    if (!inputs.has(script.inputIndex)) {
      inputs.set(script.inputIndex, {
        index: script.inputIndex,
        sighashType: script.signType ?? 1,
        ...(script.signatureAlgorithm ? { signatureAlgorithm: script.signatureAlgorithm } : {}),
      });
    }
  }
  return [...inputs.values()].sort((a, b) => a.index - b.index);
}
export function attachScripts(
  wasm: Runtime,
  signedJson: string,
  result: Built,
  capabilities = { schnorr: true, ecdsa: false },
): string {
  const tx = wasm.Transaction.deserializeFromSafeJSON(signedJson);
  const unsigned = wasm.Transaction.deserializeFromSafeJSON(
    result.psktTransactionJson,
  );
  const requested = signingInputs(result, capabilities);
  for (const input of requested) {
    if (
      !Number.isInteger(input.index) ||
      input.index < 0 ||
      input.index >= unsigned.inputs.length
    )
      throw new Error("Invalid signing input index");
  }
  const signingIndexes = new Set(requested.map((input) => input.index));
  function intent(transaction: InstanceType<Runtime["Transaction"]>) {
    const data = JSON.parse(transaction.serializeToSafeJSON());
    delete data.id;
    delete data.mass; // Derived fields may be recalculated by a signer.
    for (const index of signingIndexes)
      delete data.inputs[index].signatureScript;
    return JSON.stringify(data);
  }
  if (intent(tx) !== intent(unsigned))
    throw new Error("Wallet changed the transaction intent");
  for (const { index, sighashType } of requested) {
    const encoded = tx.inputs[index]?.signatureScript;
    if (!encoded)
      throw new Error(`Wallet omitted signature for input ${index}`);
    const raw = typeof encoded === "string" ? bytes(encoded) : encoded;
    // Both algorithms return PUSH65, a compact 64-byte signature and sighash byte.
    if (raw.length !== 66 || raw[0] !== 65 || raw[65] !== sighashType) {
      throw new Error(
        `Invalid signature encoding or sighash for input ${index}`,
      );
    }
  }
  for (const hint of result.scripts ?? []) {
    const input = tx.inputs[hint.inputIndex];
    if (!input)
      throw new Error("Covenant input missing from signed transaction");
    const requiresSignature = needsSignature(hint);
    let signature: Uint8Array = new Uint8Array();
    if (requiresSignature) {
      if (!input.signatureScript) throw new Error("Missing wallet signature");
      signature = typeof input.signatureScript === "string"
        ? bytes(input.signatureScript) : input.signatureScript;
      if (signature.length === 66 && signature[0] === 65) signature = signature.slice(1);
      if (signature.length !== 65) throw new Error("Expected compact signature and sighash byte");
    }
    const template = hint.signatureScript;
    let prefix: string | Uint8Array = input.signatureScript ?? "";
    if (template && template.mode !== "wrap-signature") {
      if (!["ordered-args", "signature-first-args"].includes(template.mode))
        throw new Error("Unsupported script template");
      const builder = new wasm.ScriptBuilder();
      if (template.mode === "signature-first-args") builder.addData(signature);
      let signatures = 0;
      for (const arg of template.args ?? []) {
        if (arg.type === "i64") builder.addI64(BigInt(arg.value));
        else if (arg.type === "data") builder.addData(bytes(arg.hex));
        else if (
          arg.type === "byte" &&
          Number.isInteger(arg.value) &&
          arg.value >= 0 &&
          arg.value <= 255
        )
          builder.addData(Uint8Array.of(arg.value));
        else if (arg.type === "signature" && template.mode === "ordered-args") {
          builder.addData(
            Uint8Array.from([...bytes(arg.prefixHex ?? ""), ...signature]),
          );
          signatures++;
        } else throw new Error("Unsupported script argument");
      }
      if (template.mode === "ordered-args" && signatures !== (requiresSignature ? 1 : 0))
        throw new Error("Unexpected signature slot count");
      prefix = builder.drain();
    }
    input.signatureScript = wasm.ScriptBuilder.fromScript(
      hint.scriptHex,
    ).encodePayToScriptHashSignatureScript(prefix);
  }
  tx.finalize();
  return tx.serializeToSafeJSON();
}
