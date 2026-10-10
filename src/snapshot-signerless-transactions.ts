/* Ported from kaspa-covenants d968dca9; parity covered by snapshot tests. */
// @ts-nocheck
import { bytesToHex, hexToBytes } from "./encoding.js";
import {
  buildKcc20ScriptForState,
  buildKcc20TransferSigScript,
  ownerAuthorizationWitness,
  p2pkOwnerWitness,
  templateParts,
} from "./abi.js";
import {
  buildClaimSignatureScripts,
  buildSnapshotStartSignatureScripts,
  encodeSnapshotBootstrapState,
  encodeSnapshotControllerState,
  parseSnapshotBootstrapState,
  parseSnapshotControllerState,
  transitionClaim,
  ZERO_32,
} from "./snapshot-signerless.js";

const NATIVE_SUBNETWORK_ID = "00".repeat(20);
const MAX_I64 = 9_223_372_036_854_775_807n;
const MAX_COMPUTE_BUDGET = 65_535;
const DEFAULT_COVENANT_COMPUTE_BUDGET = 1_000;
const START_CONTROLLER_COMPUTE_BUDGET = 100;

export function buildSnapshotControllerScriptForState(artifact, state) {
  return scriptForState(artifact, encodeSnapshotControllerState(state), "snapshot controller");
}

export function buildSnapshotBootstrapScriptForState(artifact, state) {
  return scriptForState(artifact, encodeSnapshotBootstrapState(state), "snapshot bootstrap");
}

export function deriveSnapshotTokenId(kw, {
  controllerGenesisOutpoint,
  reserves,
  kcc20Artifact,
  reserveCellKas,
}) {
  const outputs = reserves.map((state) => new kw.TransactionOutput(
    positiveI64(reserveCellKas, "reserve cell KAS"),
    kw.payToScriptHashScript(buildKcc20ScriptForState(kcc20Artifact, parseKcc20State(state))),
  ));
  return kw.covenantId(
    canonicalOutpoint(controllerGenesisOutpoint, "shard-zero controller outpoint"),
    outputs.map((output, index) => ({ index, output })),
  ).toString();
}

export function buildControllerGenesisUnsignedTransaction(kw, {
  plan,
  controllerArtifact,
  fundingInput,
  changeAddress,
  feeSompi,
  payload = null,
}) {
  requirePlan(plan, "snapshot-controller-genesis-plan");
  const script = buildSnapshotControllerScriptForState(
    controllerArtifact,
    parseSnapshotControllerState(plan.controllerState),
  );
  return genesisEnvelope(kw, {
    plan,
    fundingInput,
    changeAddress,
    feeSompi,
    payload: payload ?? deploymentPayload("KCC20SnapshotController", "controllerState", plan.controllerState),
    script,
    cellKas: BigInt(plan.controllerCellKas),
    role: "snapshot-controller",
  });
}

export function buildBootstrapGenesisUnsignedTransaction(kw, {
  plan,
  bootstrapArtifact,
  fundingInput,
  changeAddress,
  feeSompi,
  payload = null,
}) {
  requirePlan(plan, "snapshot-bootstrap-genesis-plan");
  const script = buildSnapshotBootstrapScriptForState(
    bootstrapArtifact,
    parseSnapshotBootstrapState(plan.bootstrapState),
  );
  return genesisEnvelope(kw, {
    plan,
    fundingInput,
    changeAddress,
    feeSompi,
    payload: payload ?? deploymentPayload("KCC20SnapshotBootstrap", "bootstrapState", plan.bootstrapState),
    script,
    cellKas: BigInt(plan.bootstrapCellKas),
    role: "snapshot-bootstrap",
  });
}

export function buildSnapshotStartUnsignedTransaction(kw, {
  plan,
  bootstrapArtifact,
  controllerArtifact,
  kcc20Artifact,
  bootstrapInput,
  controllerInputs,
  fundingInput,
  changeAddress,
  feeSompi,
  payload = "",
}) {
  requirePlan(plan, "snapshot-start-plan");
  if (!Array.isArray(controllerInputs) || controllerInputs.length !== plan.controllers.length) {
    throw new Error("snapshot start requires every committed controller input");
  }
  const bootstrapState = parseSnapshotBootstrapState(plan.bootstrapState);
  assertCovenantInputMatches(kw, {
    input: bootstrapInput,
    expectedScript: buildSnapshotBootstrapScriptForState(bootstrapArtifact, bootstrapState),
    expectedAmount: plan.bootstrapCellKas,
    label: "bootstrap input",
  });
  const controllerStatesBefore = plan.controllers.map((controller, index) => {
    const state = parseSnapshotControllerState(controller.stateBefore);
    assertCovenantInputMatches(kw, {
      input: controllerInputs[index],
      expectedScript: buildSnapshotControllerScriptForState(controllerArtifact, state),
      expectedAmount: plan.controllerCellKas,
      label: `controller ${index} input`,
    });
    const actualId = String(controllerInputs[index]?.utxo?.covenantId ?? "").toLowerCase();
    if (actualId && actualId !== controller.controllerId) {
      throw new Error(`controller ${index} covenant id does not match the start plan`);
    }
    return state;
  });
  const inputs = [
    covenantInput(bootstrapInput),
    ...controllerInputs.map((input) => covenantInput(input, START_CONTROLLER_COMPUTE_BUDGET)),
    publicInput(fundingInput),
  ];
  const outputs = plan.reserves.map((reserve) => new kw.TransactionOutput(
    BigInt(plan.reserveCellKas),
    kw.payToScriptHashScript(buildKcc20ScriptForState(kcc20Artifact, parseKcc20State(reserve))),
  ));
  for (const [index, controller] of plan.controllers.entries()) {
    outputs.push(covenantOutput(
      kw,
      buildSnapshotControllerScriptForState(
        controllerArtifact,
        parseSnapshotControllerState(controller.stateAfter),
      ),
      BigInt(plan.controllerCellKas),
      controller.controllerId,
      index + 1,
    ));
  }
  appendRequiredFundingChange(kw, inputs, outputs, feeSompi, fundingInput, changeAddress);
  const transaction = transactionOf(kw, inputs, outputs, 0n, payload);
  transaction.populateGenesisCovenants([
    new kw.GenesisCovenantGroup(1, plan.reserves.map((_, index) => index)),
  ]);
  const tokenIds = JSON.parse(transaction.serializeToSafeJSON()).outputs
    .slice(0, plan.reserves.length)
    .map((output) => output.covenant?.covenantId);
  if (tokenIds.some((tokenId) => String(tokenId).toLowerCase() !== plan.tokenId)) {
    throw new Error("derived snapshot token id does not match immutable bootstrap commitment");
  }
  const scripts = buildSnapshotStartSignatureScripts(kw, {
    plan,
    bootstrapArtifact,
    controllerArtifact,
    kcc20Artifact,
  });
  setP2shSignatureScript(kw, transaction, 0, bootstrapInput.script, scripts.bootstrapSignatureScript);
  for (const entry of scripts.controllerSignatureScripts) {
    setP2shSignatureScript(
      kw,
      transaction,
      entry.inputIndex,
      controllerInputs[entry.inputIndex - 1].script,
      entry.signatureScript,
    );
  }
  transaction.finalize();
  return unsignedEnvelope(kw, transaction, plan, [
    { inputIndex: inputs.length - 1, role: "funding-owner", ownerScheme: 0 },
  ]);
}

export function buildClaimUnsignedTransaction(kw, {
  plan,
  controllerArtifact,
  kcc20Artifact,
  controllerInput,
  reserveInput,
  authorityInput = null,
  fundingInput,
  changeAddress,
  feeSompi,
  ownerWitness,
  payload = "",
}) {
  requirePlan(plan, "snapshot-claim-plan");
  const before = parseSnapshotControllerState(plan.controllerStateBefore);
  assertCovenantInputMatches(kw, {
    input: controllerInput,
    expectedScript: buildSnapshotControllerScriptForState(controllerArtifact, before),
    expectedAmount: before.controllerCellKas,
    label: "controller input",
  });
  assertCovenantInputMatches(kw, {
    input: reserveInput,
    expectedScript: buildKcc20ScriptForState(kcc20Artifact, {
      amount: before.remainingAmount,
      owner: hexBytes(plan.controllerId, "controller id"),
      ownerScheme: 4,
      borrowScheme: 0,
      borrowGuard: ZERO_32,
      extensionCommitment: before.holderExtensionCommitment,
    }),
    expectedAmount: before.reserveCellKas,
    label: "reserve input",
  });
  const p2shOwner = plan.authorizationRequired === "kcc2-p2sh-participating-input";
  if (p2shOwner !== Boolean(authorityInput)) {
    throw new Error("P2SH claims require exactly one explicit authority input");
  }
  if (authorityInput) {
    authorityInput = normalizeP2shAuthorityInput(kw, {
      authorityInput,
      expectedOwner: plan.tokenOutputs.at(-1).state.owner,
      label: "P2SH authority",
    });
  }
  assertClaimOutputPlan(plan, before);
  const inputs = [
    covenantInput(controllerInput),
    covenantInput(reserveInput),
    ...(authorityInput ? [publicInput(authorityInput)] : []),
    publicInput(fundingInput),
  ];
  const outputs = plan.tokenOutputs.map((output) => covenantOutput(
    kw,
    buildKcc20ScriptForState(kcc20Artifact, parseKcc20State(output.state)),
    BigInt(output.cellKas),
    plan.tokenId,
    1,
  ));
  if (plan.controllerStateAfter) {
    outputs.push(covenantOutput(
      kw,
      buildSnapshotControllerScriptForState(
        controllerArtifact,
        parseSnapshotControllerState(plan.controllerStateAfter),
      ),
      BigInt(plan.controllerSuccessor.cellKas),
      plan.controllerId,
      0,
    ));
  }
  appendOptionalFundingChange(kw, inputs, outputs, feeSompi, fundingInput, changeAddress);
  const transaction = transactionOf(kw, inputs, outputs, BigInt(plan.transaction.lockTime), payload);
  transaction.inputs[0].sequence = BigInt(plan.transaction.controllerInputSequence);
  const recipient = parseKcc20State(plan.tokenOutputs.at(-1).state);
  const p2shWitnessIndex = 2;
  if (authorityInput && ownerWitness != null) {
    const supplied = Uint8Array.from(ownerWitness);
    if (supplied.length !== 1 || supplied[0] !== p2shWitnessIndex) {
      throw new Error("P2SH authority witness must select the dedicated authority input at index 2");
    }
  }
  const claim = {
    globalIndex: plan.globalIndex,
    shardLeafIndex: plan.shardLeafIndex,
    ownerScheme: recipient.ownerScheme,
    owner: recipient.owner,
    ownerWitness: ownerWitness ?? (p2shOwner ? Uint8Array.of(p2shWitnessIndex) : new Uint8Array(65)),
    amount: BigInt(plan.claimAmount),
    siblings: plan.proofSiblings.map((sibling) => hexBytes(sibling, "proof sibling")),
  };
  const reserveNext = plan.tokenOutputs[0]?.role === "reserve"
    ? parseKcc20State(plan.tokenOutputs[0].state)
    : emptyKcc20State();
  const template = templateParts(kcc20Artifact);
  const scripts = buildClaimSignatureScripts(kw, {
    controllerArtifact,
    kcc20Artifact,
    claim,
    reserveNext,
    recipient,
    kcc20TemplatePrefix: template.prefix,
    kcc20TemplateSuffix: template.suffix,
    nextTokenStates: plan.tokenOutputs.map((output) => parseKcc20State(output.state)),
  });
  setP2shSignatureScript(kw, transaction, 0, controllerInput.script, scripts.controllerSignatureScript);
  setP2shSignatureScript(kw, transaction, 1, reserveInput.script, scripts.kcc20SignatureScript);
  if (authorityInput) setP2shSignatureScript(kw, transaction, 2, authorityInput.script, authorityInput.unlockPrefix);
  transaction.finalize();
  const fundingIndex = inputs.length - 1;
  const signInputs = p2shOwner
    ? [
      { inputIndex: 2, role: "p2sh-owner-authority", ownerScheme: 3, explicitRevealRecipe: true },
      { inputIndex: fundingIndex, role: "funding-owner", ownerScheme: 0 },
    ]
    : [
      { inputIndex: 0, role: "entitlement-owner", ownerScheme: 0, rewritesControllerWitness: true },
      { inputIndex: fundingIndex, role: "funding-owner", ownerScheme: 0 },
    ];
  return unsignedEnvelope(kw, transaction, plan, signInputs);
}

export function buildRecipientTransferUnsignedTransaction(kw, {
  kcc20Artifact,
  migrationId,
  tokenId,
  tokenInput,
  fundingInput,
  authorityInput = null,
  recipient,
  tokenChange = null,
  tokenCellKas,
  changeAddress,
  feeSompi,
  payload = "",
}) {
  const inputState = parseKcc20State(tokenInput.state);
  const states = [parseKcc20State(recipient), ...(tokenChange ? [parseKcc20State(tokenChange)] : [])];
  const p2shOwner = inputState.ownerScheme === 3;
  if (![0, 3].includes(inputState.ownerScheme) || p2shOwner !== Boolean(authorityInput)) {
    throw new Error("claimed token owner authorization is invalid");
  }
  if (states.reduce((sum, state) => sum + state.amount, 0n) !== inputState.amount) {
    throw new Error("recipient transfer token outputs do not conserve the claimed input");
  }
  if (authorityInput) {
    authorityInput = normalizeP2shAuthorityInput(kw, {
      authorityInput,
      expectedOwner: bytesToHex(inputState.owner),
      label: "P2SH claimed-token authority",
    });
  }
  const inputs = [covenantInput(tokenInput), ...(authorityInput ? [publicInput(authorityInput)] : []), publicInput(fundingInput)];
  const outputs = states.map((state) => covenantOutput(
    kw,
    buildKcc20ScriptForState(kcc20Artifact, state),
    tokenCellKas,
    tokenId,
    0,
  ));
  appendOptionalFundingChange(kw, inputs, outputs, feeSompi, fundingInput, changeAddress);
  const transaction = transactionOf(kw, inputs, outputs, 0n, payload);
  setP2shSignatureScript(kw, transaction, 0, tokenInput.script, buildKcc20TransferSigScript(kw, kcc20Artifact, {
    nextStates: states,
    witness: p2shOwner ? ownerAuthorizationWitness(Uint8Array.of(1)) : p2pkOwnerWitness(new Uint8Array(65)),
  }));
  if (authorityInput) setP2shSignatureScript(kw, transaction, 1, authorityInput.script, authorityInput.unlockPrefix);
  transaction.finalize();
  const fundingIndex = inputs.length - 1;
  return unsignedEnvelope(kw, transaction, {
    schema: "kaspacom-snapshot-wallet-operation/v2",
    kind: "snapshot-recipient-transfer",
    migrationId,
    tokenId,
  }, p2shOwner
    ? [{ inputIndex: 1, role: "p2sh-claimed-token-authority", ownerScheme: 3, explicitRevealRecipe: true }, { inputIndex: fundingIndex, role: "funding-owner", ownerScheme: 0 }]
    : [{ inputIndex: 0, role: "claimed-token-owner", ownerScheme: 0 }, { inputIndex: fundingIndex, role: "funding-owner", ownerScheme: 0 }]);
}

function scriptForState(artifact, encoded, label) {
  const script = Uint8Array.from(artifact?.script ?? artifact?.bytecode ?? []);
  const start = artifact?.state_layout?.start;
  const length = artifact?.state_layout?.len;
  if (!Number.isInteger(start) || !Number.isInteger(length) || encoded.length !== length) {
    throw new Error(`${label} artifact state layout does not match encoded state`);
  }
  return concat(script.slice(0, start), encoded, script.slice(start + length));
}

function genesisEnvelope(kw, {
  plan,
  fundingInput,
  changeAddress,
  feeSompi,
  payload,
  script,
  cellKas,
  role,
}) {
  const inputs = [publicInput(fundingInput)];
  const outputs = [new kw.TransactionOutput(cellKas, kw.payToScriptHashScript(script))];
  appendOptionalFundingChange(kw, inputs, outputs, feeSompi, fundingInput, changeAddress);
  const transaction = transactionOf(kw, inputs, outputs, 0n, payload);
  transaction.populateGenesisCovenants([new kw.GenesisCovenantGroup(0, [0])]);
  transaction.finalize();
  return unsignedEnvelope(kw, transaction, { ...plan, outputRole: role }, [
    { inputIndex: 0, role: "funding-owner", ownerScheme: 0 },
  ]);
}

function deploymentPayload(template, name, value) {
  return new TextEncoder().encode(JSON.stringify({
    tn10: { v: 1, tmpl: template, args: [{ name, type: "object", value }] },
  }));
}

function transactionOf(kw, inputs, outputs, lockTime, payload) {
  assertDistinctInputOutpoints(inputs);
  return new kw.Transaction({
    version: 1,
    lockTime,
    inputs,
    outputs,
    subnetworkId: NATIVE_SUBNETWORK_ID,
    gas: 0n,
    payload,
  });
}

function publicInput(input) {
  const previous = canonicalOutpoint(input?.previousOutpoint, "previous outpoint");
  const utxo = canonicalOutpoint(input?.utxo?.outpoint, "UTXO outpoint");
  if (previous.transactionId !== utxo.transactionId || previous.index !== utxo.index) {
    throw new Error("public input previous outpoint does not match the UTXO outpoint");
  }
  return {
    previousOutpoint: input.previousOutpoint,
    utxo: input.utxo,
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: normalizedComputeBudget(input.computeBudget, 30),
  };
}

function covenantInput(input, defaultComputeBudget = DEFAULT_COVENANT_COMPUTE_BUDGET) {
  if (!input?.script) throw new Error("covenant input is missing its public reveal script");
  return {
    ...publicInput(input),
    computeBudget: normalizedComputeBudget(input.computeBudget, defaultComputeBudget),
  };
}

function normalizedComputeBudget(value, fallback) {
  const budget = Number(value ?? fallback);
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_COMPUTE_BUDGET) {
    throw new Error("input compute budget must be an unsigned 16-bit integer");
  }
  return budget;
}

function assertCovenantInputMatches(kw, { input, expectedScript, expectedAmount, label }) {
  const actualScript = arbitraryBytes(input?.script, `${label} reveal script`);
  if (!equalBytes(actualScript, expectedScript)) throw new Error(`${label} reveal script does not match the operation plan`);
  const expectedSpk = String(kw.payToScriptHashScript(expectedScript).script).toLowerCase();
  const actualSpk = String(input?.utxo?.scriptPublicKey?.script ?? input?.utxo?.scriptPublicKey ?? "").toLowerCase();
  if (actualSpk !== expectedSpk) throw new Error(`${label} script public key does not match the reveal script`);
  if (inputAmount(input.utxo) !== BigInt(expectedAmount)) throw new Error(`${label} cell KAS does not match the operation plan`);
}

function covenantOutput(kw, script, amount, covenantId, authorizingInput) {
  return new kw.TransactionOutput(
    positiveI64(amount, "covenant output KAS"),
    kw.payToScriptHashScript(script),
    new kw.CovenantBinding(authorizingInput, new kw.Hash(covenantId)),
  );
}

function appendRequiredFundingChange(kw, inputs, outputs, feeSompi, fundingInput, changeAddress) {
  const before = outputs.length;
  appendOptionalFundingChange(kw, inputs, outputs, feeSompi, fundingInput, changeAddress);
  if (outputs.length !== before + 1) {
    throw new Error("snapshot start requires one positive plain funding-change output");
  }
}

function appendOptionalFundingChange(kw, inputs, outputs, feeSompi, fundingInput, changeAddress) {
  const totalInput = inputs.reduce((sum, input) => sum + inputAmount(input.utxo), 0n);
  const totalOutput = outputs.reduce((sum, output) => sum + BigInt(output.value ?? output.amount), 0n);
  const change = totalInput - totalOutput - positiveI64(feeSompi, "fee");
  if (change < 0n) throw new Error("public inputs do not fund outputs and fee");
  if (change === 0n) return;
  const scriptPublicKey = fundingInput.utxo?.scriptPublicKey;
  if (!scriptPublicKey) throw new Error("funding UTXO is missing its script public key");
  const networkId = fundingInput.networkId ?? "testnet-10";
  const fundingAddress = kw.addressFromScriptPublicKey(scriptPublicKey, networkId).toString();
  if (changeAddress && changeAddress !== fundingAddress) {
    throw new Error("change address does not match the funding input script");
  }
  outputs.push(new kw.TransactionOutput(change, scriptPublicKey));
}

function assertDistinctInputOutpoints(inputs) {
  const seen = new Set();
  for (const input of inputs) {
    const outpoint = canonicalOutpoint(input.previousOutpoint, "transaction input previous outpoint");
    const key = `${outpoint.transactionId}:${outpoint.index}`;
    if (seen.has(key)) throw new Error(`duplicate transaction input outpoint ${key}`);
    seen.add(key);
  }
}

function canonicalOutpoint(outpoint, label) {
  const transactionId = String(outpoint?.transactionId ?? "").toLowerCase();
  const index = Number(outpoint?.index);
  if (!/^[0-9a-f]{64}$/.test(transactionId)
    || !Number.isSafeInteger(index)
    || index < 0
    || index > 0xffffffff) {
    throw new Error(`${label} is malformed`);
  }
  return { transactionId, index };
}

function setP2shSignatureScript(kw, transaction, inputIndex, revealScript, prefix) {
  transaction.inputs[inputIndex].signatureScript = kw.ScriptBuilder
    .fromScript(revealScript, { flags: { covenantsEnabled: true } })
    .encodePayToScriptHashSignatureScript(prefix);
}

function unsignedEnvelope(kw, transaction, intent, signInputs) {
  return {
    schema: "kaspacom-funded-unsigned-transaction/v2",
    submitted: false,
    transaction,
    unsignedTransaction: JSON.parse(transaction.serializeToSafeJSON()),
    legacySdkCombinedMass: kw.calculateTransactionMass("testnet-10", transaction, 1).toString(),
    legacySdkStandardMaximum: kw.maximumStandardTransactionMass().toString(),
    networkValidationRequired: true,
    readyForSigning: false,
    signInputs,
    intent: JSON.parse(JSON.stringify(intent)),
  };
}

function requirePlan(plan, kind) {
  if (plan?.schema !== "kaspacom-snapshot-wallet-operation/v2"
    || plan?.kind !== kind
    || plan?.planOnly !== true) {
    throw new Error(`expected ${kind}`);
  }
}

function normalizeP2shAuthorityInput(kw, { authorityInput, expectedOwner, label }) {
  if (!authorityInput?.script || !Object.hasOwn(authorityInput, "unlockPrefix")) {
    throw new Error(`${label} input requires an explicit reveal script and unlock prefix`);
  }
  const reveal = arbitraryBytes(authorityInput.script, `${label} reveal script`);
  const unlockPrefix = arbitraryBytes(authorityInput.unlockPrefix, `${label} unlock prefix`, true);
  const actualSpk = String(authorityInput.utxo?.scriptPublicKey?.script ?? authorityInput.utxo?.scriptPublicKey ?? "").toLowerCase();
  if (actualSpk !== `aa20${String(expectedOwner).toLowerCase()}87`
    || String(kw.payToScriptHashScript(reveal).script).toLowerCase() !== actualSpk) {
    throw new Error(`${label} input does not match the token owner`);
  }
  return { ...authorityInput, script: reveal, unlockPrefix };
}

function assertClaimOutputPlan(plan, before) {
  const outputs = Array.isArray(plan.tokenOutputs) ? plan.tokenOutputs : [];
  const transition = transitionClaim({
    context: before.snapshotContext,
    shard: {
      shardIndex: before.shardIndex,
      globalIndexStart: before.globalIndexStart,
      holderCount: before.holderCount,
      depth: before.treeDepth,
      allocationTotal: before.remainingAmount,
      initialRoot: before.remainingRoot,
    },
    currentRoot: before.remainingRoot,
    currentReserveAmount: before.remainingAmount,
    claim: {
      globalIndex: plan.globalIndex,
      shardLeafIndex: plan.shardLeafIndex,
      ownerScheme: plan.claimOwnerScheme,
      owner: plan.claimOwner,
      amount: plan.claimAmount,
      siblings: plan.proofSiblings,
    },
  });
  const nextRoot = bytesToHex(transition.nextRoot);
  const previousRoot = bytesToHex(before.remainingRoot);
  const expectedAuthorization = transition.ownerScheme === 0
    ? "kcc2-p2pk-schnorr-signature"
    : "kcc2-p2sh-participating-input";
  if (plan.previousRoot !== previousRoot
    || plan.nextRoot !== nextRoot
    || BigInt(plan.claimAmount) !== transition.claimAmount
    || Boolean(plan.terminal) !== transition.terminal
    || plan.authorizationRequired !== expectedAuthorization) {
    throw new Error("claim transition summary does not match the bound entitlement proof");
  }
  if (plan.terminal) {
    if (outputs.length !== 1
      || outputs[0]?.role !== "recipient"
      || plan.controllerStateAfter
      || plan.controllerSuccessor) {
      throw new Error("terminal claim plan must contain only the recipient output");
    }
  } else if (outputs.length !== 2
    || outputs[0]?.role !== "reserve"
    || outputs[1]?.role !== "recipient"
    || !plan.controllerStateAfter
    || !plan.controllerSuccessor) {
    throw new Error("nonterminal claim plan must contain reserve, recipient, and controller successor outputs");
  }
  const recipient = parseKcc20State(outputs.at(-1).state);
  const expectedRecipientKas = transition.terminal
    ? before.reserveCellKas + before.controllerCellKas
    : before.recipientMinCellKas;
  if (BigInt(outputs.at(-1).cellKas) !== expectedRecipientKas
    || recipient.amount !== transition.claimAmount
    || recipient.ownerScheme !== transition.ownerScheme
    || !equalBytes(recipient.owner, transition.owner)
    || recipient.borrowScheme !== 0
    || !equalBytes(recipient.borrowGuard, ZERO_32)
    || !equalBytes(recipient.extensionCommitment, before.holderExtensionCommitment)) {
    throw new Error("claim recipient output does not match the bound entitlement state");
  }
  if (transition.terminal) return;

  const reserve = parseKcc20State(outputs[0].state);
  if (BigInt(outputs[0].cellKas) !== before.reserveCellKas
    || reserve.amount !== transition.remainingAmount
    || reserve.ownerScheme !== 4
    || !equalBytes(reserve.owner, hexBytes(plan.controllerId, "controller id"))
    || reserve.borrowScheme !== 0
    || !equalBytes(reserve.borrowGuard, ZERO_32)
    || !equalBytes(reserve.extensionCommitment, before.holderExtensionCommitment)) {
    throw new Error("claim reserve output does not match the controller-bound remainder");
  }

  const after = parseSnapshotControllerState(plan.controllerStateAfter);
  const expectedAfter = {
    ...before,
    remainingRoot: transition.nextRoot,
    remainingAmount: transition.remainingAmount,
    claimsProcessed: before.claimsProcessed + 1n,
  };
  for (const [key, expected] of Object.entries(expectedAfter)) {
    const actual = after[key];
    const matches = expected instanceof Uint8Array
      ? equalBytes(actual, expected)
      : actual === expected;
    if (!matches) throw new Error(`claim controller successor changed ${key}`);
  }
  if (BigInt(plan.controllerSuccessor.cellKas) !== before.controllerCellKas
    || plan.controllerSuccessor.remainingRoot !== nextRoot
    || BigInt(plan.controllerSuccessor.remainingAmount) !== transition.remainingAmount
    || BigInt(plan.controllerSuccessor.claimsProcessed) !== before.claimsProcessed + 1n) {
    throw new Error("claim controller successor summary does not match its state");
  }
}

function parseKcc20State(state) {
  return {
    amount: BigInt(state.amount),
    owner: hexBytes(state.owner, "KCC20 owner"),
    ownerScheme: Number(state.ownerScheme),
    borrowScheme: Number(state.borrowScheme ?? 0),
    borrowGuard: hexBytes(state.borrowGuard ?? "00".repeat(32), "KCC20 borrow guard"),
    extensionCommitment: hexBytes(state.extensionCommitment, "KCC20 extension commitment"),
  };
}

function emptyKcc20State() {
  return {
    amount: 0n,
    owner: ZERO_32,
    ownerScheme: 0,
    borrowScheme: 0,
    borrowGuard: ZERO_32,
    extensionCommitment: ZERO_32,
  };
}

function inputAmount(utxo) {
  const value = utxo?.amount ?? utxo?.utxoEntry?.amount;
  if (value == null) throw new Error("UTXO is missing public amount");
  return BigInt(value);
}

function positiveI64(value, label) {
  const number = BigInt(value);
  if (number <= 0n || number > MAX_I64) throw new Error(`${label} must be a positive signed 64-bit integer`);
  return number;
}

function hexBytes(value, label) {
  const normalized = String(value).replace(/^0x/, "");
  if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(normalized)) {
    throw new Error(`${label} must be exactly 32 bytes of hexadecimal data`);
  }
  return hexToBytes(normalized);
}

function arbitraryBytes(value, label, allowEmpty = false) {
  if (typeof value !== "string") {
    const bytes = Uint8Array.from(value ?? []);
    if (!allowEmpty && bytes.length === 0) throw new Error(`${label} must not be empty`);
    return bytes;
  }
  const normalized = value.replace(/^0x/, "");
  if ((!allowEmpty && normalized.length === 0) || !/^(?:[0-9a-fA-F]{2})*$/.test(normalized)) {
    throw new Error(`${label} must be complete hexadecimal bytes`);
  }
  return hexToBytes(normalized);
}

function equalBytes(a, b) {
  const left = Uint8Array.from(a ?? []);
  const right = Uint8Array.from(b ?? []);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
