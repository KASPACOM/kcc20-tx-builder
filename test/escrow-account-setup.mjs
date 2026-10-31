import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildKcc20InitialFeeAccount,
  buildKcc20FeeEscrowScript,
  planKcc20FeeAccountBinding,
} from "../dist/index.js";

const artifact = JSON.parse(readFileSync(new URL("../artifacts/KCC20FeeEscrowV1.placeholder.json", import.meta.url)));
const tokenId = "01".repeat(32);
const accountId = "04".repeat(32);
const marketId = "02".repeat(32);
const policyId = "03".repeat(32);
const owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const txid = "0a".repeat(32);
const principalSompi = 300000000n;

function fixture() {
  const initial = buildKcc20InitialFeeAccount({
    artifact, tokenId, ownerSchnorrPublicKey: owner, principalSompi,
  });
  const indexed = {
    txidHex: txid, vout: 0, covenantIdHex: accountId,
    scriptHashHex: initial.scriptHash, amountSompiExact: principalSompi.toString(),
    status: "active", spentByTxidHex: null,
    state: { ...initial.state, roleName: "account" },
  };
  const live = {
    outpoint: { transactionId: txid, index: 0 },
    amountSompi: principalSompi, covenantIdHex: accountId,
    scriptPublicKey: initial.scriptPublicKey,
  };
  return { initial, indexed, live };
}

test("initial fee account is an unbound pinned script with separate principal", () => {
  const { initial } = fixture();
  assert.equal(initial.state.market, "00".repeat(32));
  assert.equal(initial.state.policy, "00".repeat(32));
  assert.equal(initial.state.owner_scheme, 0);
  assert.equal(initial.amountSompi, principalSompi);
  assert.equal(initial.redeemScript.length, artifact.contracts.KCC20FeeEscrowV1.compiled.bytecode.length);
  assert.equal(initial.scriptPublicKey.scriptHex, `aa20${initial.scriptHash}87`);
});

test("one-time bind retains account lineage, owner and exact KAS principal", () => {
  const { indexed, live, initial } = fixture();
  const result = planKcc20FeeAccountBinding({ artifact, indexed, live, tokenId, accountId, marketId, policyId });
  assert.equal(result.entrypoint, "bindMarket");
  assert.deepEqual(result.currentRedeemScript, initial.redeemScript);
  assert.equal(result.account.covenantId, accountId);
  assert.equal(result.successorState.market, marketId);
  assert.equal(result.successorState.policy, policyId);
  assert.equal(result.successorState.owner, owner);
  assert.equal(result.successorState.action_hash, "00".repeat(32));
  assert.equal(result.successorAmountSompi, principalSompi);
  assert.equal(result.requiresOwnerSchnorrSignature, true);
  assert.equal(result.requiresSeparateNetworkFunding, true);
  const expected = buildKcc20FeeEscrowScript(artifact, result.successorState);
  assert.deepEqual(result.successorRedeemScript, expected.redeemScript);
  assert.deepEqual(result.successorScriptPublicKey, expected.scriptPublicKey);
});

test("binding refuses stale, forged, already bound, or altered account evidence", () => {
  const { indexed, live } = fixture();
  const bind = changes => planKcc20FeeAccountBinding({
    artifact, indexed, live, tokenId, accountId, marketId, policyId, ...changes,
  });
  for (const changes of [
    { marketId: "00".repeat(32) },
    { live: { ...live, amountSompi: 1n } },
    { live: { ...live, covenantIdHex: marketId } },
    { indexed: { ...indexed, status: "spent" } },
    { indexed: { ...indexed, state: { ...indexed.state, market: marketId } } },
    { indexed: { ...indexed, state: { ...indexed.state, owner_scheme: 1 } } },
    { indexed: { ...indexed, state: { ...indexed.state, action_hash: "09".repeat(32) } } },
  ]) assert.throws(() => bind(changes));
});

test("initial account rejects malformed identity, principal and artifact", () => {
  const create = changes => buildKcc20InitialFeeAccount({
    artifact, tokenId, ownerSchnorrPublicKey: owner, principalSompi, ...changes,
  });
  for (const changes of [
    { tokenId: "00".repeat(32) },
    { ownerSchnorrPublicKey: "00".repeat(32) },
    { ownerSchnorrPublicKey: "ff".repeat(32) },
    { principalSompi: 0n },
    { principalSompi: 1 },
    { artifact: { ...artifact, schema_version: 2 } },
  ]) assert.throws(() => create(changes));
});
