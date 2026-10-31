import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as kw from "../examples/vendor/kaspa/kaspa.js";
import {
  buildKcc20InitialFeeAccount,
  buildKcc20FeeEscrowScript,
  createKcc20PsktBuilderEngine,
} from "../dist/index.js";

kw.initSync({ module: readFileSync(new URL("../examples/vendor/kaspa/kaspa_bg.wasm", import.meta.url)) });
const artifact = JSON.parse(readFileSync(new URL("../artifacts/KCC20FeeEscrowV1.placeholder.json", import.meta.url)));
const key = new kw.PrivateKey("03".padStart(64, "0"));
const owner = key.toKeypair().xOnlyPublicKey.toString();
const wallet = key.toAddress("testnet-10").toString();
const tokenId = "01".repeat(32);
const marketId = "02".repeat(32);
const policyId = "03".repeat(32);
const accountId = "04".repeat(32);
const accountTxid = "0a".repeat(32);
const fundingTxid = "0b".repeat(32);
const principalSompi = 300000000n;

function fixture(mutate = () => {}) {
  const initial = buildKcc20InitialFeeAccount({
    artifact, tokenId, ownerSchnorrPublicKey: owner, principalSompi,
  });
  const accountSpk = kw.payToScriptHashScript(initial.redeemScript);
  const accountAddress = kw.addressFromScriptPublicKey(accountSpk, "testnet-10").toString();
  const accountEntry = {
    outpoint: { transactionId: accountTxid, index: 0 },
    amount: principalSompi, scriptPublicKey: accountSpk,
    blockDaaScore: 0n, isCoinbase: false, covenantId: accountId,
  };
  const fundingEntry = {
    outpoint: { transactionId: fundingTxid, index: 0 },
    amount: 200000000n, scriptPublicKey: kw.payToAddressScript(wallet),
    blockDaaScore: 0n, isCoinbase: false,
  };
  const walletEntries = [fundingEntry];
  const indexed = {
    address: accountAddress, txidHex: accountTxid, vout: 0,
    covenantIdHex: accountId, scriptHashHex: initial.scriptHash,
    amountSompiExact: principalSompi.toString(), status: "active",
    spentByTxidHex: null, state: { ...initial.state, roleName: "account" },
  };
  const request = {
    schema: "kcc20-in-process-pskt-builder-input/v1",
    request: {
      builderKey: "kcc20fee.bind-account", network: "testnet-10",
      owner: { walletAddress: wallet, kcc20Owner: owner },
      params: { tokenId, accountId, marketId, policyId, activeAccountUtxo: indexed },
    },
  };
  const fixture = { initial, indexed, request, accountEntry, fundingEntry, walletEntries, accountAddress };
  mutate(fixture);
  const engine = createKcc20PsktBuilderEngine({
    wasm: kw, artifacts: { "KCC20FeeEscrowV1.placeholder.json": artifact },
    rpcClientFactory: () => ({
      connect: async () => {}, disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => ({
        entries: addresses.includes(wallet) ? walletEntries : [accountEntry],
      }),
    }),
  });
  return { ...fixture, engine };
}

function signedMassAndPaidFee(f, built) {
  const json = JSON.parse(built.psktTransactionJson);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const accountSignature = Buffer.from(
    kw.createInputSignature(signed, 0, key, kw.SighashType.All), "hex",
  );
  const normalizedAccountSignature = accountSignature.length === 66 && accountSignature[0] === 65
    ? accountSignature.subarray(1) : accountSignature;
  assert.equal(normalizedAccountSignature.length, 65);
  const args = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  for (const arg of built.scripts[0].signatureScript.args) {
    if (arg.type === "data") args.addData(Buffer.from(arg.hex, "hex"));
    else if (arg.type === "signature") args.addData(normalizedAccountSignature);
    else if (arg.type === "i64") args.addI64(BigInt(arg.value));
    else throw new Error(`unsupported script argument ${arg.type}`);
  }
  signed.inputs[0].signatureScript = kw.ScriptBuilder.fromScript(
    Buffer.from(built.scripts[0].scriptHex, "hex"),
    { flags: { covenantsEnabled: true } },
  ).encodePayToScriptHashSignatureScript(args.drain());
  signed.inputs[1].signatureScript = kw.createInputSignature(signed, 1, key, kw.SighashType.All);
  const { transactionMass } = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee account bind");
  const storageMass = f.engine.protocol.calculateToccataStorageMass(signed, "fee account bind");
  const paidFee = principalSompi + f.fundingEntry.amount -
    BigInt(json.outputs[0].value) - BigInt(json.outputs[1].value);
  return { transactionMass, storageMass, paidFee };
}

test("fee account creation builds a signed genesis output with its own covenant lineage", async () => {
  const f = fixture(({ fundingEntry, request }) => {
    fundingEntry.amount = 500000000n;
    request.request.builderKey = "kcc20fee.create-account";
    request.request.params = { tokenId, principalSompi: principalSompi.toString() };
  });
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.equal(json.version, 1);
  assert.equal(json.inputs.length, 1);
  assert.equal(json.outputs[0].scriptPublicKey, `0000${f.initial.scriptPublicKey.scriptHex}`);
  assert.equal(BigInt(json.outputs[0].value), principalSompi);
  assert.equal(json.outputs[0].covenant.authorizingInput, 0);
  assert.equal(json.outputs[0].covenant.covenantId, built.metadata.accountId);
  assert.notEqual(built.metadata.accountId, "00".repeat(32));
  assert.equal(built.metadata.accountGenesisHint.address, f.accountAddress);
  assert.equal(built.metadata.accountGenesisHint.scriptHashHex, f.initial.scriptHash);
  assert.equal(built.metadata.accountGenesisHint.state.market, "00".repeat(32));
  assert.equal(built.metadata.accountGenesisHint.txidHex, undefined);
  assert.deepEqual(built.signInputs, [{ index: 0, sighashType: 1 }]);
  assert.deepEqual(built.scripts, []);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  signed.inputs[0].signatureScript = kw.createInputSignature(signed, 0, key, kw.SighashType.All);
  const { transactionMass } = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee account genesis");
  const storageMass = f.engine.protocol.calculateToccataStorageMass(signed, "fee account genesis");
  const paidFee = f.fundingEntry.amount - BigInt(json.outputs[0].value) - BigInt(json.outputs[1].value);
  assert(transactionMass <= 450000n);
  assert(storageMass <= 450000n);
  assert(paidFee >= (transactionMass > storageMass ? transactionMass : storageMass) * 100n);
});

test("creation hint can bind after its accepted outpoint appears on the node", async () => {
  const f = fixture(({ fundingEntry, request }) => {
    fundingEntry.amount = 500000000n;
    request.request.builderKey = "kcc20fee.create-account";
    request.request.params = { tokenId, principalSompi: principalSompi.toString() };
  });
  const created = await f.engine.build(f.request);
  f.accountEntry.covenantId = created.metadata.accountId;
  f.fundingEntry.outpoint.transactionId = "0c".repeat(32);
  f.request.request.builderKey = "kcc20fee.bind-account";
  f.request.request.params = {
    tokenId, accountId: created.metadata.accountId, marketId, policyId,
    accountGenesisHint: { ...created.metadata.accountGenesisHint, txidHex: accountTxid },
  };
  const bound = await f.engine.build(f.request);
  const boundJson = JSON.parse(bound.psktTransactionJson);
  assert.equal(bound.metadata.accountId, created.metadata.accountId);
  assert.equal(boundJson.outputs[0].covenant.covenantId, created.metadata.accountId);
  assert.equal(BigInt(boundJson.outputs[0].value), principalSompi);
  assert.deepEqual(bound.signInputs, [{ index: 1, sighashType: 1 }]);
});

test("fee account creation rejects a principal too small for storage mass", async () => {
  const f = fixture(({ fundingEntry, request }) => {
    fundingEntry.amount = 500000000n;
    request.request.builderKey = "kcc20fee.create-account";
    request.request.params = { tokenId, principalSompi: "1" };
  });
  await assert.rejects(f.engine.build(f.request), /mass target|insufficient change/);
});

test("fee account creation rejects an owner key that differs from its funding wallet", async () => {
  const f = fixture(({ fundingEntry, request }) => {
    fundingEntry.amount = 500000000n;
    request.request.builderKey = "kcc20fee.create-account";
    request.request.params = { tokenId, principalSompi: principalSompi.toString() };
    request.request.owner.kcc20Owner = "11".repeat(32);
  });
  await assert.rejects(f.engine.build(f.request), /owner must match the connected Schnorr wallet address/);
});

test("fee account binding builds a wallet-signable v1 PSKT and preserves principal", async () => {
  const f = fixture();
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.equal(json.version, 1);
  assert.equal(json.inputs.length, 2);
  assert.equal(json.outputs[0].covenant.covenantId, accountId);
  assert.equal(json.outputs[0].covenant.authorizingInput, 0);
  assert.equal(BigInt(json.outputs[0].value), principalSompi);
  assert.equal(built.scripts.length, 1);
  assert.equal(built.scripts[0].signatureScript.mode, "ordered-args");
  assert.deepEqual(built.scripts[0].signatureScript.args.map(arg => arg.type),
    ["data", "data", "signature", "i64", "data"]);
  assert.deepEqual(built.signInputs, [{ index: 1, sighashType: 1 }]);
  const expected = buildKcc20FeeEscrowScript(artifact, {
    ...f.initial.state, market: marketId, policy: policyId,
  });
  assert.equal(json.outputs[0].scriptPublicKey, `0000${expected.scriptPublicKey.scriptHex}`);
  assert.equal(built.metadata.accountPrincipalSompi, principalSompi.toString());

  const { transactionMass, storageMass, paidFee } = signedMassAndPaidFee(f, built);
  assert(transactionMass <= 450000n, `signed transaction mass ${transactionMass}`);
  assert(storageMass <= 450000n, `signed storage mass ${storageMass}`);
  assert(paidFee >= (transactionMass > storageMass ? transactionMass : storageMass) * 100n);
});

test("small funding pays the final signed storage fee or fails before signing", async () => {
  const enough = fixture(({ fundingEntry }) => { fundingEntry.amount = 30000000n; });
  const built = await enough.engine.build(enough.request);
  const { transactionMass, storageMass, paidFee } = signedMassAndPaidFee(enough, built);
  assert(transactionMass <= 450000n);
  assert(storageMass <= 450000n);
  assert(paidFee >= (transactionMass > storageMass ? transactionMass : storageMass) * 100n);

  for (const amount of [20000000n, 10000000n]) {
    const insufficient = fixture(({ fundingEntry }) => { fundingEntry.amount = amount; });
    await assert.rejects(insufficient.engine.build(insufficient.request),
      /fee account binding.*mass|insufficient change|predicted signed transaction exceeds/);
  }
});

test("fee account binding rejects spent source and wrong wallet owner", async () => {
  const spent = fixture(({ request }) => { request.request.params.activeAccountUtxo.status = "spent"; });
  await assert.rejects(spent.engine.build(spent.request), /not active/);
  const wrongOwner = fixture(({ request }) => { request.request.owner.kcc20Owner = "11".repeat(32); });
  await assert.rejects(wrongOwner.engine.build(wrongOwner.request), /does not match connected wallet/);
});

test("fee account binding rejects a funding wallet different from its owner key", async () => {
  const f = fixture(({ request }) => {
    const other = new kw.PrivateKey("04".padStart(64, "0"));
    request.request.owner.walletAddress = other.toAddress("testnet-10").toString();
  });
  await assert.rejects(f.engine.build(f.request), /owner must match the connected Schnorr wallet address/);
});

test("fee account binding automatically skips an account outpoint in wallet funding", async () => {
  const f = fixture(({ accountEntry, walletEntries }) => {
    walletEntries.push(accountEntry);
  });
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.equal(json.inputs[0].transactionId, accountTxid);
  assert.equal(json.inputs[1].transactionId, fundingTxid);
});

test("fee account binding excludes its account outpoint from funding", async () => {
  const f = fixture(({ request, accountEntry, walletEntries }) => {
    walletEntries.push(accountEntry);
    request.request.params.fundingOutpoint = `${accountTxid}:0`;
  });
  await assert.rejects(f.engine.build(f.request), /pinned funding UTXO.*unavailable/);
});
