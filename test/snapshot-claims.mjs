#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from 'node:url';
const wasmPath = process.env.SNAPSHOT_TEST_WASM;
if (!wasmPath) throw new Error('SNAPSHOT_TEST_WASM must point to the pinned kaspa-wasm-toc directory');
async function initKaspa() {
  const kw = await import(pathToFileURL(`${wasmPath}/kaspa.js`));
  kw.initSync(await readFile(`${wasmPath}/kaspa_bg.wasm`));
  return kw;
}
import { buildKcc20ScriptForState, templateParts } from "../dist/abi.js";
import {
  branchNode,
  buildClaimPlan,
  buildClaimSignatureScripts,
  entitlementLeaf,
} from "../dist/snapshot-signerless.js";
import {
  buildClaimUnsignedTransaction,
  buildRecipientTransferUnsignedTransaction,
  buildSnapshotControllerScriptForState,
} from "../dist/snapshot-signerless-transactions.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(`${repoRoot}/${path}`, "utf8"));
const [kcc20, controller, bootstrap] = await Promise.all([
  readJson("artifacts/KCC20.placeholder.json"),
  readJson("artifacts/KCC20SnapshotController.placeholder.json"),
  readJson("artifacts/KCC20SnapshotBootstrap.placeholder.json"),
]);
const kw = await initKaspa();
const bytes = (value) => Uint8Array.from({ length: 32 }, () => value);
const hex = (value) => Buffer.from(value).toString("hex");
const migration = bytes(0x33);
const extension = bytes(0x44);
const manifest = bytes(0x55);
const context = bytes(0x66);
const tokenId = hex(bytes(0x11));
const controllerId = hex(bytes(0x22));
const fundingScript = new kw.ScriptPublicKey(0, `20${hex(bytes(0x99))}ac`);
const changeAddress = kw.addressFromScriptPublicKey(fundingScript, "testnet-10").toString();
let marker = 1;

const input = (amount, scriptPublicKey, extra = {}) => {
  const outpoint = {
    transactionId: `${(marker++).toString(16).padStart(2, "0")}`.repeat(32),
    index: 0,
  };
  return {
    previousOutpoint: outpoint,
    utxo: {
      outpoint,
      amount,
      scriptPublicKey,
      blockDaaScore: 1n,
      isCoinbase: false,
    },
    networkId: "testnet-10",
    ...extra,
  };
};

const parseControllerState = (state) => {
  const bytesFields = new Set([
    "migrationId",
    "tokenId",
    "holderExtensionCommitment",
    "manifestCommitment",
    "snapshotContext",
    "kcc20TemplateHash",
    "bootstrapTemplateHash",
    "deploymentGuardCommitment",
    "remainingRoot",
  ]);
  return Object.fromEntries(Object.entries(state).map(([key, value]) => [
    key,
    bytesFields.has(key) ? Uint8Array.from(Buffer.from(value, "hex")) : BigInt(value),
  ]));
};

const parseTokenState = (state) => ({
  amount: BigInt(state.amount),
  owner: Uint8Array.from(Buffer.from(state.owner, "hex")),
  ownerScheme: Number(state.ownerScheme),
  borrowScheme: Number(state.borrowScheme),
  borrowGuard: Uint8Array.from(Buffer.from(state.borrowGuard, "hex")),
  extensionCommitment: Uint8Array.from(Buffer.from(state.extensionCommitment, "hex")),
});

const planFor = ({ ownerScheme, owner, authoritySibling = bytes(0xbb) }) => {
  const claim = {
    globalIndex: 0,
    shardLeafIndex: 0,
    ownerScheme,
    owner,
    amount: 100n,
  };
  const sibling = entitlementLeaf(context, {
    globalIndex: 1,
    ownerScheme: 0,
    owner: authoritySibling,
    amount: 200n,
  });
  claim.siblings = [sibling];
  const initialRoot = branchNode(entitlementLeaf(context, claim), sibling);
  const shard = {
    shardIndex: 0,
    globalIndexStart: 0,
    holderCount: 2,
    depth: 1,
    allocationTotal: 300n,
    initialRoot,
  };
  return {
    claim,
    plan: buildClaimPlan({
      migrationId: "signerless-transaction-test",
      migrationCommitment: migration,
      controllerArtifact: controller,
      bootstrapArtifact: bootstrap,
      kcc20Artifact: kcc20,
      controllerId,
      tokenId,
      holderExtensionCommitment: extension,
      manifestCommitment: manifest,
      context,
      shard,
      shardCount: 1,
      deploymentGuardCommitment: bytes(0x77),
      currentRoot: initialRoot,
      currentReserveAmount: 300n,
      currentClaimsProcessed: 0n,
      claim,
      controllerCellKas: 50_000_000n,
      reserveCellKas: 50_000_000n,
      claimNotBeforeDaaScore: 100n,
    }),
  };
};

const claimInputs = (plan) => {
  const controllerScript = buildSnapshotControllerScriptForState(
    controller,
    parseControllerState(plan.controllerStateBefore),
  );
  const reserveState = {
    amount: 300n,
    owner: Uint8Array.from(Buffer.from(controllerId, "hex")),
    ownerScheme: 4,
    borrowScheme: 0,
    borrowGuard: new Uint8Array(32),
    extensionCommitment: extension,
  };
  const reserveScript = buildKcc20ScriptForState(kcc20, reserveState);
  return {
    controllerScript,
    reserveScript,
    controllerInput: input(
      50_000_000n,
      kw.payToScriptHashScript(controllerScript),
      { script: controllerScript },
    ),
    reserveInput: input(
      50_000_000n,
      kw.payToScriptHashScript(reserveScript),
      { script: reserveScript },
    ),
  };
};

const p2pkOwner = bytes(0xaa);
const { claim: p2pkClaim, plan: p2pkPlan } = planFor({
  ownerScheme: 0,
  owner: p2pkOwner,
});
const p2pkInputs = claimInputs(p2pkPlan);
const p2pkEnvelope = buildClaimUnsignedTransaction(kw, {
  plan: p2pkPlan,
  controllerArtifact: controller,
  kcc20Artifact: kcc20,
  controllerInput: p2pkInputs.controllerInput,
  reserveInput: p2pkInputs.reserveInput,
  fundingInput: input(300_000_000n, fundingScript),
  changeAddress,
  feeSompi: 10_000n,
});
assert.equal(p2pkEnvelope.unsignedTransaction.lockTime, "100");
assert.equal(p2pkEnvelope.unsignedTransaction.inputs[0].sequence, "0");
assert.equal(p2pkEnvelope.unsignedTransaction.inputs[1].sequence, "0");
assert.equal(p2pkEnvelope.unsignedTransaction.inputs.length, 3);
assert.equal(p2pkEnvelope.unsignedTransaction.outputs.length, 4);
assert.equal(p2pkEnvelope.unsignedTransaction.outputs[0].value, "50000000");
assert.equal(p2pkEnvelope.unsignedTransaction.outputs[0].covenant.covenantId, tokenId);
assert.equal(p2pkEnvelope.unsignedTransaction.outputs[1].value, "50000000");
assert.equal(p2pkEnvelope.unsignedTransaction.outputs[1].covenant.covenantId, tokenId);
assert.equal(p2pkEnvelope.unsignedTransaction.outputs[2].value, "50000000");
assert.equal(p2pkEnvelope.unsignedTransaction.outputs[2].covenant.covenantId, controllerId);
assert.equal(p2pkEnvelope.unsignedTransaction.outputs[3].covenant, null);
assert.deepEqual(p2pkEnvelope.signInputs, [
  {
    inputIndex: 0,
    role: "entitlement-owner",
    ownerScheme: 0,
    rewritesControllerWitness: true,
  },
  { inputIndex: 2, role: "funding-owner", ownerScheme: 0 },
]);
assert.notEqual(p2pkEnvelope.unsignedTransaction.inputs[0].signatureScript, "");
assert.notEqual(p2pkEnvelope.unsignedTransaction.inputs[1].signatureScript, "");
assert.equal(p2pkEnvelope.unsignedTransaction.inputs[2].signatureScript, "");
assert.equal(p2pkEnvelope.networkValidationRequired, true);
assert.equal(p2pkEnvelope.readyForSigning, false);

const kcc20Template = templateParts(kcc20);
const directClaimScripts = buildClaimSignatureScripts(kw, {
  controllerArtifact: controller,
  kcc20Artifact: kcc20,
  claim: {
    ...p2pkClaim,
    ownerWitness: new Uint8Array(65),
  },
  reserveNext: parseTokenState(p2pkPlan.tokenOutputs[0].state),
  recipient: parseTokenState(p2pkPlan.tokenOutputs.at(-1).state),
  kcc20TemplatePrefix: kcc20Template.prefix,
  kcc20TemplateSuffix: kcc20Template.suffix,
  nextTokenStates: p2pkPlan.tokenOutputs.map(({ state }) => parseTokenState(state)),
});
assert.ok(directClaimScripts.controllerSignatureScript.length > 0);
assert.ok(directClaimScripts.kcc20SignatureScript.length > 0);
assert.throws(() => buildClaimSignatureScripts(kw, {
  controllerArtifact: controller,
  kcc20Artifact: kcc20,
  claim: { ...p2pkClaim, ownerWitness: Uint8Array.of(0) },
  reserveNext: parseTokenState(p2pkPlan.tokenOutputs[0].state),
  recipient: parseTokenState(p2pkPlan.tokenOutputs.at(-1).state),
  kcc20TemplatePrefix: kcc20Template.prefix,
  kcc20TemplateSuffix: kcc20Template.suffix,
  nextTokenStates: p2pkPlan.tokenOutputs.map(({ state }) => parseTokenState(state)),
}), /P2PK Schnorr entitlement witness must be 65 bytes/);

const wrongControllerScript = Uint8Array.from(p2pkInputs.controllerScript);
wrongControllerScript[wrongControllerScript.length - 1] ^= 1;
assert.throws(() => buildClaimUnsignedTransaction(kw, {
  plan: p2pkPlan,
  controllerArtifact: controller,
  kcc20Artifact: kcc20,
  controllerInput: input(
    50_000_000n,
    kw.payToScriptHashScript(wrongControllerScript),
    { script: wrongControllerScript },
  ),
  reserveInput: claimInputs(p2pkPlan).reserveInput,
  fundingInput: input(300_000_000n, fundingScript),
  changeAddress,
  feeSompi: 10_000n,
}), /controller input reveal script does not match/);

const wrongKasInputs = claimInputs(p2pkPlan);
wrongKasInputs.reserveInput.utxo.amount = 50_000_001n;
assert.throws(() => buildClaimUnsignedTransaction(kw, {
  plan: p2pkPlan,
  controllerArtifact: controller,
  kcc20Artifact: kcc20,
  controllerInput: wrongKasInputs.controllerInput,
  reserveInput: wrongKasInputs.reserveInput,
  fundingInput: input(300_000_000n, fundingScript),
  changeAddress,
  feeSompi: 10_000n,
}), /reserve input cell KAS does not match/);

const duplicateClaimInputs = claimInputs(p2pkPlan);
duplicateClaimInputs.reserveInput.previousOutpoint = duplicateClaimInputs.controllerInput.previousOutpoint;
duplicateClaimInputs.reserveInput.utxo.outpoint = duplicateClaimInputs.controllerInput.previousOutpoint;
assert.throws(() => buildClaimUnsignedTransaction(kw, {
  plan: p2pkPlan,
  controllerArtifact: controller,
  kcc20Artifact: kcc20,
  controllerInput: duplicateClaimInputs.controllerInput,
  reserveInput: duplicateClaimInputs.reserveInput,
  fundingInput: input(300_000_000n, fundingScript),
  changeAddress,
  feeSompi: 10_000n,
}), /duplicate transaction input outpoint/);

const redirectedClaimPlan = structuredClone(p2pkPlan);
redirectedClaimPlan.tokenOutputs.at(-1).state.owner = hex(bytes(0xee));
assert.throws(() => {
  const inputs = claimInputs(redirectedClaimPlan);
  return buildClaimUnsignedTransaction(kw, {
    plan: redirectedClaimPlan,
    controllerArtifact: controller,
    kcc20Artifact: kcc20,
    controllerInput: inputs.controllerInput,
    reserveInput: inputs.reserveInput,
    fundingInput: input(300_000_000n, fundingScript),
    changeAddress,
    feeSompi: 10_000n,
  });
}, /claim recipient output does not match the bound entitlement state/);

const mutatedReservePlan = structuredClone(p2pkPlan);
mutatedReservePlan.tokenOutputs[0].state.amount = "199";
assert.throws(() => {
  const inputs = claimInputs(mutatedReservePlan);
  return buildClaimUnsignedTransaction(kw, {
    plan: mutatedReservePlan,
    controllerArtifact: controller,
    kcc20Artifact: kcc20,
    controllerInput: inputs.controllerInput,
    reserveInput: inputs.reserveInput,
    fundingInput: input(300_000_000n, fundingScript),
    changeAddress,
    feeSompi: 10_000n,
  });
}, /claim reserve output does not match the controller-bound remainder/);

const mutatedSuccessorPlan = structuredClone(p2pkPlan);
mutatedSuccessorPlan.controllerStateAfter.remainingAmount = "199";
assert.throws(() => {
  const inputs = claimInputs(mutatedSuccessorPlan);
  return buildClaimUnsignedTransaction(kw, {
    plan: mutatedSuccessorPlan,
    controllerArtifact: controller,
    kcc20Artifact: kcc20,
    controllerInput: inputs.controllerInput,
    reserveInput: inputs.reserveInput,
    fundingInput: input(300_000_000n, fundingScript),
    changeAddress,
    feeSompi: 10_000n,
  });
}, /claim controller successor changed remainingAmount/);

const authorityReveal = Uint8Array.of(0x51);
const authorityScript = kw.payToScriptHashScript(authorityReveal);
const p2shOwner = Uint8Array.from(Buffer.from(authorityScript.script.slice(4, 68), "hex"));
const { plan: p2shPlan } = planFor({ ownerScheme: 3, owner: p2shOwner });
assert.throws(() => {
  const inputs = claimInputs(p2shPlan);
  return buildClaimUnsignedTransaction(kw, {
    plan: p2shPlan,
    controllerArtifact: controller,
    kcc20Artifact: kcc20,
    controllerInput: inputs.controllerInput,
    reserveInput: inputs.reserveInput,
    fundingInput: input(300_000_000n, fundingScript),
    changeAddress,
    feeSompi: 10_000n,
  });
}, /P2SH claims require exactly one explicit authority input/);

assert.throws(() => {
  const inputs = claimInputs(p2shPlan);
  return buildClaimUnsignedTransaction(kw, {
    plan: p2shPlan,
    controllerArtifact: controller,
    kcc20Artifact: kcc20,
    controllerInput: inputs.controllerInput,
    reserveInput: inputs.reserveInput,
    authorityInput: input(1_000_000n, authorityScript),
    fundingInput: input(300_000_000n, fundingScript),
    changeAddress,
    feeSompi: 10_000n,
  });
}, /explicit reveal script and unlock prefix/);

const p2shInputs = claimInputs(p2shPlan);
const p2shEnvelope = buildClaimUnsignedTransaction(kw, {
  plan: p2shPlan,
  controllerArtifact: controller,
  kcc20Artifact: kcc20,
  controllerInput: p2shInputs.controllerInput,
  reserveInput: p2shInputs.reserveInput,
  authorityInput: input(1_000_000n, authorityScript, {
    script: authorityReveal,
    unlockPrefix: new Uint8Array(),
  }),
  fundingInput: input(300_000_000n, fundingScript),
  changeAddress,
  feeSompi: 10_000n,
});
assert.deepEqual(p2shEnvelope.signInputs, [
  {
    inputIndex: 2,
    role: "p2sh-owner-authority",
    ownerScheme: 3,
    explicitRevealRecipe: true,
  },
  { inputIndex: 3, role: "funding-owner", ownerScheme: 0 },
]);
assert.notEqual(p2shEnvelope.unsignedTransaction.inputs[2].signatureScript, "");

const p2pkClaimedState = p2pkPlan.tokenOutputs.at(-1).state;
const p2pkClaimedScript = buildKcc20ScriptForState(kcc20, parseTokenState(p2pkClaimedState));
const recipient = {
  ...p2pkClaimedState,
  owner: hex(bytes(0xcc)),
};
const p2pkTransfer = buildRecipientTransferUnsignedTransaction(kw, {
  kcc20Artifact: kcc20,
  migrationId: "signerless-transaction-test",
  tokenId,
  tokenInput: input(50_000_000n, kw.payToScriptHashScript(p2pkClaimedScript), {
    script: p2pkClaimedScript,
    state: p2pkClaimedState,
  }),
  fundingInput: input(100_000_000n, fundingScript),
  recipient,
  tokenCellKas: 50_000_000n,
  changeAddress,
  feeSompi: 10_000n,
});
assert.deepEqual(p2pkTransfer.signInputs, [
  { inputIndex: 0, role: "claimed-token-owner", ownerScheme: 0 },
  { inputIndex: 1, role: "funding-owner", ownerScheme: 0 },
]);
assert.equal(p2pkTransfer.unsignedTransaction.outputs.length, 2);
assert.notEqual(p2pkTransfer.unsignedTransaction.inputs[0].signatureScript, "");

assert.throws(() => buildRecipientTransferUnsignedTransaction(kw, {
  kcc20Artifact: kcc20,
  migrationId: "signerless-transaction-test",
  tokenId,
  tokenInput: input(50_000_000n, kw.payToScriptHashScript(p2pkClaimedScript), {
    script: p2pkClaimedScript,
    state: p2pkClaimedState,
  }),
  fundingInput: input(100_000_000n, fundingScript),
  recipient: { ...recipient, amount: "99" },
  tokenCellKas: 50_000_000n,
  changeAddress,
  feeSompi: 10_000n,
}), /do not conserve the claimed input/);

const duplicateTokenInput = input(50_000_000n, kw.payToScriptHashScript(p2pkClaimedScript), {
  script: p2pkClaimedScript,
  state: p2pkClaimedState,
});
const duplicateFundingInput = input(100_000_000n, fundingScript);
duplicateFundingInput.previousOutpoint = duplicateTokenInput.previousOutpoint;
duplicateFundingInput.utxo.outpoint = duplicateTokenInput.previousOutpoint;
assert.throws(() => buildRecipientTransferUnsignedTransaction(kw, {
  kcc20Artifact: kcc20,
  migrationId: "signerless-transaction-test",
  tokenId,
  tokenInput: duplicateTokenInput,
  fundingInput: duplicateFundingInput,
  recipient,
  tokenCellKas: 50_000_000n,
  changeAddress,
  feeSompi: 10_000n,
}), /duplicate transaction input outpoint/);

const mismatchedFundingInput = input(100_000_000n, fundingScript);
mismatchedFundingInput.previousOutpoint = { transactionId: "ab".repeat(32), index: 0 };
assert.throws(() => buildRecipientTransferUnsignedTransaction(kw, {
  kcc20Artifact: kcc20,
  migrationId: "signerless-transaction-test",
  tokenId,
  tokenInput: input(50_000_000n, kw.payToScriptHashScript(p2pkClaimedScript), {
    script: p2pkClaimedScript,
    state: p2pkClaimedState,
  }),
  fundingInput: mismatchedFundingInput,
  recipient,
  tokenCellKas: 50_000_000n,
  changeAddress,
  feeSompi: 10_000n,
}), /previous outpoint does not match/);

const malformedFundingInput = input(100_000_000n, fundingScript);
malformedFundingInput.previousOutpoint = {
  transactionId: "ac".repeat(32),
  index: 0x100000000,
};
malformedFundingInput.utxo.outpoint = malformedFundingInput.previousOutpoint;
assert.throws(() => buildRecipientTransferUnsignedTransaction(kw, {
  kcc20Artifact: kcc20,
  migrationId: "signerless-transaction-test",
  tokenId,
  tokenInput: input(50_000_000n, kw.payToScriptHashScript(p2pkClaimedScript), {
    script: p2pkClaimedScript,
    state: p2pkClaimedState,
  }),
  fundingInput: malformedFundingInput,
  recipient,
  tokenCellKas: 50_000_000n,
  changeAddress,
  feeSompi: 10_000n,
}), /previous outpoint is malformed/);

const p2shClaimedState = p2shPlan.tokenOutputs.at(-1).state;
const p2shClaimedScript = buildKcc20ScriptForState(kcc20, parseTokenState(p2shClaimedState));
const p2shRecipient = {
  ...p2shClaimedState,
  owner: hex(bytes(0xcd)),
  ownerScheme: 0,
};
const p2shTokenInput = () => input(
  50_000_000n,
  kw.payToScriptHashScript(p2shClaimedScript),
  { script: p2shClaimedScript, state: p2shClaimedState },
);
assert.throws(() => buildRecipientTransferUnsignedTransaction(kw, {
  kcc20Artifact: kcc20,
  migrationId: "signerless-transaction-test",
  tokenId,
  tokenInput: p2shTokenInput(),
  fundingInput: input(100_000_000n, fundingScript),
  recipient: p2shRecipient,
  tokenCellKas: 50_000_000n,
  changeAddress,
  feeSompi: 10_000n,
}), /claimed token owner authorization is invalid/);

const wrongReveal = Uint8Array.of(0x52);
assert.throws(() => buildRecipientTransferUnsignedTransaction(kw, {
  kcc20Artifact: kcc20,
  migrationId: "signerless-transaction-test",
  tokenId,
  tokenInput: p2shTokenInput(),
  authorityInput: input(1_000_000n, kw.payToScriptHashScript(wrongReveal), {
    script: wrongReveal,
    unlockPrefix: new Uint8Array(),
  }),
  fundingInput: input(100_000_000n, fundingScript),
  recipient: p2shRecipient,
  tokenCellKas: 50_000_000n,
  changeAddress,
  feeSompi: 10_000n,
}), /P2SH claimed-token authority input does not match/);

const p2shTransfer = buildRecipientTransferUnsignedTransaction(kw, {
  kcc20Artifact: kcc20,
  migrationId: "signerless-transaction-test",
  tokenId,
  tokenInput: p2shTokenInput(),
  authorityInput: input(1_000_000n, authorityScript, {
    script: authorityReveal,
    unlockPrefix: new Uint8Array(),
  }),
  fundingInput: input(100_000_000n, fundingScript),
  recipient: p2shRecipient,
  tokenCellKas: 50_000_000n,
  changeAddress,
  feeSompi: 10_000n,
});
assert.deepEqual(p2shTransfer.signInputs, [
  {
    inputIndex: 1,
    role: "p2sh-claimed-token-authority",
    ownerScheme: 3,
    explicitRevealRecipe: true,
  },
  { inputIndex: 2, role: "funding-owner", ownerScheme: 0 },
]);
assert.notEqual(p2shTransfer.unsignedTransaction.inputs[1].signatureScript, "");
assert.equal(p2shTransfer.networkValidationRequired, true);
assert.equal(p2shTransfer.readyForSigning, false);

console.log("signerless snapshot claim and recipient transaction tests passed");
