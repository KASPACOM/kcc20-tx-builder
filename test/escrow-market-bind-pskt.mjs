import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as kw from "../examples/vendor/kaspa/kaspa.js";
import {
  buildKcc20InitialFeeAccount, buildKcc20ScriptForState,
  createKcc20PsktBuilderEngine, kcc20CreatorFeeConsent,
  prepareKcc20FeeMarketGenesis, templateParts,
} from "../dist/index.js";

kw.initSync({ module: readFileSync(new URL("../examples/vendor/kaspa/kaspa_bg.wasm", import.meta.url)) });
const keys = {
  receipt: "KCC20FeeEscrowV1", root: "KCC20OrderbookFeeRootV1",
  holder: "KCC20OrderbookFeeHolderV1", ask: "KCC20OrderbookFeeAskV1",
  bid: "KCC20OrderbookFeeBidV1", ticket: "KCC20FeeTicket",
  wrapper: "KCC20WrapperFeeV1", argentWrapper: "KCC20WrapperFeeArgentV1",
};
const artifacts = Object.fromEntries(Object.entries(keys).map(([role, name]) => [
  role, JSON.parse(readFileSync(new URL(`../artifacts/${name}.placeholder.json`, import.meta.url))),
]));
const artifactMap = Object.fromEntries(Object.entries(keys).map(([role, name]) => [
  `${name}.placeholder.json`, artifacts[role],
]));
const hex = bytes => Buffer.from(bytes).toString("hex");
const tuple = role => {
  const parts = templateParts(artifacts[role]);
  return { hash: hex(parts.hash), prefixLength: parts.prefixLength, suffixLength: parts.suffixLength };
};
const policy = {
  version: 1, creatorFeeBps: 0,
  protocolAccountId: "04".repeat(32), creatorAccountId: "00".repeat(32),
  ...Object.fromEntries(["receipt", "root", "holder", "ask", "bid", "ticket"]
    .map(role => [`${role}Template`, tuple(role)])),
};
const tokenId = "01".repeat(32);
const marketId = "02".repeat(32);
const key = new kw.PrivateKey("03".padStart(64, "0"));
const owner = key.toKeypair().xOnlyPublicKey.toString();
const wallet = key.toAddress("testnet-10").toString();

function fixture() {
  const genesis = prepareKcc20FeeMarketGenesis({
    tokenId, feeTicketId: "00".repeat(32), priceScale: 1n,
    policy, wrapperProfile: "native", artifacts,
  });
  const wrapperSpk = kw.payToScriptHashScript(genesis.wrapper.redeemScript);
  const wrapperAddress = kw.addressFromScriptPublicKey(wrapperSpk, "testnet-10").toString();
  const wrapperEntry = {
    outpoint: { transactionId: "0a".repeat(32), index: 0 },
    amount: 100000000n, scriptPublicKey: wrapperSpk,
    blockDaaScore: 0n, isCoinbase: false, covenantId: marketId,
  };
  const fundingEntry = {
    outpoint: { transactionId: "0b".repeat(32), index: 0 },
    amount: 400000000n, scriptPublicKey: kw.payToAddressScript(wallet),
    blockDaaScore: 0n, isCoinbase: false,
  };
  const request = {
    schema: "kcc20-in-process-pskt-builder-input/v1",
    request: {
      builderKey: "kcc20fee.bind-market", network: "testnet-10",
      owner: { walletAddress: wallet, kcc20Owner: owner },
      params: {
        marketId, contractCanonicalTokenId: tokenId, feeTicketId: "00".repeat(32),
        priceScale: "1", wrapperProfile: "native", feePolicy: policy,
        policyId: genesis.policyId, rootPrincipalSompi: "100000000",
        wrapperGenesisHint: {
          txidHex: wrapperEntry.outpoint.transactionId, vout: 0,
          address: wrapperAddress, covenantIdHex: marketId,
          scriptHashHex: genesis.wrapper.scriptHash,
          amountSompiExact: "100000000", state: genesis.state,
        },
      },
    },
  };
  const engine = createKcc20PsktBuilderEngine({
    wasm: kw, artifacts: artifactMap,
    rpcClientFactory: () => ({
      connect: async () => {}, disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => ({
        entries: addresses.includes(wallet) ? [fundingEntry] : [wrapperEntry],
      }),
    }),
  });
  return { engine, request, wrapperEntry, fundingEntry };
}

test("fee-market binding builds a wallet-signable two-output continuation", async () => {
  const f = fixture();
  const built = await f.engine.build(f.request);
  const json = JSON.parse(built.psktTransactionJson);
  assert.deepEqual(built.signInputs, [{ index: 1, sighashType: 1 }]);
  assert.equal(json.outputs[0].covenant.covenantId, marketId);
  assert.equal(json.outputs[1].covenant.covenantId, marketId);
  assert.equal(json.outputs[0].covenant.authorizingInput, 0);
  assert.equal(json.outputs[1].covenant.authorizingInput, 0);
  assert.equal(BigInt(json.outputs[0].value), f.wrapperEntry.amount);
  assert.equal(BigInt(json.outputs[1].value), 100000000n);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  const args = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
  for (const arg of built.scripts[0].signatureScript.args) {
    if (arg.type === "data") args.addData(Buffer.from(arg.hex, "hex"));
    else if (arg.type === "i64") args.addI64(BigInt(arg.value));
    else if (arg.type === "byte") args.addData(Uint8Array.of(arg.value));
    else throw new Error(`unsupported binding argument ${arg.type}`);
  }
  signed.inputs[0].signatureScript = kw.ScriptBuilder.fromScript(
    Buffer.from(built.scripts[0].scriptHex, "hex"),
    { flags: { covenantsEnabled: true } },
  ).encodePayToScriptHashSignatureScript(args.drain());
  signed.inputs[1].signatureScript = kw.createInputSignature(signed, 1, key, kw.SighashType.All);
  const { transactionMass } = f.engine.protocol.calculateToccataV1NonContextualMass(signed, "fee-market bind");
  const storageMass = f.engine.protocol.calculateToccataStorageMass(signed, "fee-market bind");
  assert(transactionMass <= 450000n);
  assert(storageMass <= 450000n);
  const paidFee = f.wrapperEntry.amount + f.fundingEntry.amount -
    json.outputs.reduce((sum, output) => sum + BigInt(output.value), 0n);
  assert(paidFee >= (transactionMass > storageMass ? transactionMass : storageMass) * 100n);
});

test("binding rejects a mismatched genesis hint", async () => {
  const f = fixture();
  f.request.request.params.wrapperGenesisHint.scriptHashHex = "ff".repeat(32);
  await assert.rejects(f.engine.build(f.request), /genesis hint differs/);
});

test("binding rejects a spent or changed live wrapper", async () => {
  const f = fixture();
  f.wrapperEntry.covenantId = "ff".repeat(32);
  await assert.rejects(f.engine.build(f.request), /covenant id|covenant ID|covenant lineage/i);
});

test("creator-fee binding remains closed until consent is authenticated", async () => {
  const f = fixture();
  f.request.request.params.feePolicy = {
    ...policy, creatorFeeBps: 100, creatorAccountId: "05".repeat(32),
  };
  await assert.rejects(f.engine.build(f.request), /verified creator owner/);
});

test("creator consent authorizes only the exact accepted market and policy", async () => {
  const f = fixture();
  const creatorPolicy = { ...policy, creatorFeeBps: 100,
    creatorAccountId: "05".repeat(32) };
  const creatorGenesis = prepareKcc20FeeMarketGenesis({ tokenId,
    feeTicketId: "00".repeat(32), priceScale: 1n,
    policy: creatorPolicy, wrapperProfile: "native", artifacts });
  f.wrapperEntry.scriptPublicKey = kw.payToScriptHashScript(
    creatorGenesis.wrapper.redeemScript);
  const params = f.request.request.params;
  params.feePolicy = creatorPolicy;
  params.policyId = creatorGenesis.policyId;
  params.creatorAccount = { accountId: creatorPolicy.creatorAccountId };
  params.wrapperGenesisHint = { ...params.wrapperGenesisHint,
    address: kw.addressFromScriptPublicKey(f.wrapperEntry.scriptPublicKey,
      "testnet-10").toString(),
    scriptHashHex: creatorGenesis.wrapper.scriptHash,
    state: creatorGenesis.state };
  params.creatorEvidence = { contractCanonicalTokenId: tokenId,
    creatorOwner: owner, claimVerified: true, verificationStatus: "verified",
    classificationStatus: "matched", ownerScheme: 0, creatorConsentAvailable: true };
  const consent = kcc20CreatorFeeConsent({ tokenId, marketId,
    feeTicketId: "00".repeat(32), priceScale: 1n, policy: creatorPolicy });
  params.creatorConsent = { creatorOwner: owner,
    signature: kw.signMessage({ message: consent.message, privateKey: key }) };
  const built = await f.engine.build(f.request);
  assert.equal(built.metadata.creatorConsentCommitment, consent.commitment);
  assert.equal(built.metadata.creatorConsentOwner, owner);
  params.creatorConsent.signature = kw.signMessage({ message: "different market",
    privateKey: key });
  await assert.rejects(f.engine.build(f.request), /does not authorize this exact market/);
  params.creatorConsent.signature = kw.signMessage({ message: consent.message,
    privateKey: key });
  params.creatorEvidence.claimVerified = false;
  await assert.rejects(f.engine.build(f.request), /verified token creator evidence/);
});

test("fee-market genesis signs one disabled wrapper and fixes its KIP-20 ID", async () => {
  const native = JSON.parse(readFileSync(new URL("../artifacts/KCC20.placeholder.json", import.meta.url)));
  const argent = JSON.parse(readFileSync(new URL("../artifacts/ArgentKCC20.reference.json", import.meta.url)));
  const tokenState = {
    amount: 1n, owner: Buffer.from(owner, "hex"), ownerScheme: 0,
    borrowScheme: 0, borrowGuard: new Uint8Array(32),
    extensionCommitment: new Uint8Array(32),
  };
  const tokenScript = buildKcc20ScriptForState(native, tokenState);
  const tokenSpk = kw.payToScriptHashScript(tokenScript);
  const tokenAddress = kw.addressFromScriptPublicKey(tokenSpk, "testnet-10").toString();
  const tokenEntry = {
    outpoint: { transactionId: "0c".repeat(32), index: 0 },
    amount: 100000000n, scriptPublicKey: tokenSpk,
    blockDaaScore: 0n, isCoinbase: false, covenantId: tokenId,
  };
  const account = buildKcc20InitialFeeAccount({
    artifact: artifacts.receipt, tokenId,
    ownerSchnorrPublicKey: owner, principalSompi: 300000000n,
  });
  const accountSpk = kw.payToScriptHashScript(account.redeemScript);
  const accountAddress = kw.addressFromScriptPublicKey(accountSpk, "testnet-10").toString();
  const accountEntry = {
    outpoint: { transactionId: "0d".repeat(32), index: 0 },
    amount: 300000000n, scriptPublicKey: accountSpk,
    blockDaaScore: 0n, isCoinbase: false, covenantId: policy.protocolAccountId,
  };
  const fundingEntry = {
    outpoint: { transactionId: "0e".repeat(32), index: 0 },
    amount: 500000000n, scriptPublicKey: kw.payToAddressScript(wallet),
    blockDaaScore: 0n, isCoinbase: false,
  };
  const genesis = prepareKcc20FeeMarketGenesis({
    tokenId, feeTicketId: "00".repeat(32), priceScale: 1n,
    policy, wrapperProfile: "native", artifacts,
  });
  const engine = createKcc20PsktBuilderEngine({
    wasm: kw, artifacts: {
      ...artifactMap, "KCC20.placeholder.json": native,
      "ArgentKCC20.reference.json": argent,
    },
    rpcClientFactory: () => ({
      connect: async () => {}, disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => ({
        entries: addresses.includes(tokenAddress) ? [tokenEntry]
          : addresses.includes(accountAddress) ? [accountEntry] : [fundingEntry],
      }),
    }),
  });
  const built = await engine.build({
    schema: "kcc20-in-process-pskt-builder-input/v1",
    request: {
      builderKey: "kcc20fee.deploy-market-genesis", network: "testnet-10",
      owner: { walletAddress: wallet, kcc20Owner: owner },
      params: {
        canonicalCovenantId: tokenId, feeTicketId: "00".repeat(32),
        priceScale: "1", feePolicy: policy, policyId: genesis.policyId,
        wrapperPrincipalSompi: "100000000",
        tokenUtxo: {
          txidHex: tokenEntry.outpoint.transactionId, vout: 0, address: tokenAddress,
          state: {
            stateAmount: "1", owner, ownerScheme: 0, borrowScheme: 0,
            borrowGuard: "00".repeat(32), extensionCommitment: "00".repeat(32),
          },
        },
        protocolAccount: {
          accountId: policy.protocolAccountId,
          txidHex: accountEntry.outpoint.transactionId, vout: 0,
          address: accountAddress, amountSompiExact: "300000000",
          scriptHashHex: account.scriptHash, state: account.state,
        },
      },
    },
  });
  const json = JSON.parse(built.psktTransactionJson);
  assert.equal(json.outputs.length, 2);
  assert.equal(json.outputs[0].covenant.covenantId, built.metadata.marketId);
  assert.equal(json.outputs[1].covenant, null);
  assert.equal(built.metadata.wrapperGenesisHint.state.enabled, false);
  const signed = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  signed.inputs[0].signatureScript = kw.createInputSignature(signed, 0, key, kw.SighashType.All);
  const { transactionMass } = engine.protocol.calculateToccataV1NonContextualMass(signed, "fee-market genesis");
  const storageMass = engine.protocol.calculateToccataStorageMass(signed, "fee-market genesis");
  assert(transactionMass <= 450000n);
  assert(storageMass <= 450000n);
});

test("creator-fee genesis verifies both unbound accounts without spending them", async () => {
  const native = JSON.parse(readFileSync(new URL("../artifacts/KCC20.placeholder.json", import.meta.url)));
  const creatorPolicy = { ...policy, creatorFeeBps: 500,
    creatorAccountId: "05".repeat(32) };
  const tokenScript = buildKcc20ScriptForState(native, {
    amount: 1n, owner: Buffer.from(owner, "hex"), ownerScheme: 0,
    borrowScheme: 0, borrowGuard: new Uint8Array(32),
    extensionCommitment: new Uint8Array(32),
  });
  const tokenSpk = kw.payToScriptHashScript(tokenScript);
  const tokenAddress = kw.addressFromScriptPublicKey(tokenSpk, "testnet-10").toString();
  const tokenEntry = { outpoint: { transactionId: "0c".repeat(32), index: 0 },
    amount: 100000000n, scriptPublicKey: tokenSpk, blockDaaScore: 0n,
    isCoinbase: false, covenantId: tokenId };
  const account = buildKcc20InitialFeeAccount({ artifact: artifacts.receipt,
    tokenId, ownerSchnorrPublicKey: owner, principalSompi: 300000000n });
  const accountSpk = kw.payToScriptHashScript(account.redeemScript);
  const accountAddress = kw.addressFromScriptPublicKey(accountSpk,
    "testnet-10").toString();
  const accountEntry = (transactionId, covenantId) => ({
    outpoint: { transactionId, index: 0 }, amount: 300000000n,
    scriptPublicKey: accountSpk, blockDaaScore: 0n,
    isCoinbase: false, covenantId,
  });
  const fundingEntry = { outpoint: { transactionId: "0e".repeat(32), index: 0 },
    amount: 500000000n, scriptPublicKey: kw.payToAddressScript(wallet),
    blockDaaScore: 0n, isCoinbase: false };
  const genesis = prepareKcc20FeeMarketGenesis({ tokenId,
    feeTicketId: "00".repeat(32), priceScale: 1n, policy: creatorPolicy,
    wrapperProfile: "native", artifacts });
  const accountHint = (transactionId, accountId) => ({
    accountId, txidHex: transactionId, vout: 0, address: accountAddress,
    amountSompiExact: "300000000", scriptHashHex: account.scriptHash,
    state: account.state,
  });
  const params = { canonicalCovenantId: tokenId,
    feeTicketId: "00".repeat(32), priceScale: "1",
    feePolicy: creatorPolicy, policyId: genesis.policyId,
    wrapperPrincipalSompi: "100000000",
    tokenUtxo: { txidHex: tokenEntry.outpoint.transactionId, vout: 0,
      address: tokenAddress, state: { stateAmount: "1", owner,
        ownerScheme: 0, borrowScheme: 0, borrowGuard: "00".repeat(32),
        extensionCommitment: "00".repeat(32) } },
    protocolAccount: accountHint("0d".repeat(32), policy.protocolAccountId),
    creatorAccount: accountHint("0f".repeat(32), creatorPolicy.creatorAccountId),
  };
  const engine = createKcc20PsktBuilderEngine({ wasm: kw, artifacts: {
    ...artifactMap, "KCC20.placeholder.json": native,
  }, rpcClientFactory: () => ({
    connect: async () => {}, disconnect: async () => {},
    getUtxosByAddresses: async ({ addresses }) => ({ entries:
      addresses.includes(tokenAddress) ? [tokenEntry]
        : addresses.includes(accountAddress) ? [
          accountEntry("0d".repeat(32), policy.protocolAccountId),
          accountEntry("0f".repeat(32), creatorPolicy.creatorAccountId),
        ] : [fundingEntry],
    }),
  }) });
  const request = { schema: "kcc20-in-process-pskt-builder-input/v1", request: {
    builderKey: "kcc20fee.deploy-market-genesis", network: "testnet-10",
    owner: { walletAddress: wallet, kcc20Owner: owner }, params,
  } };
  const built = await engine.build(request);
  const transaction = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
  transaction.inputs[0].signatureScript = kw.createInputSignature(transaction, 0,
    key, kw.SighashType.All);
  assert.equal(transaction.inputs.length, 1);
  assert.equal(transaction.inputs[0].previousOutpoint.transactionId,
    fundingEntry.outpoint.transactionId);
  assert.equal(transaction.outputs.length, 2);
  assert(engine.protocol.calculateToccataV1NonContextualMass(transaction,
    "creator genesis").transactionMass <= 450000n);
  params.creatorAccount.txidHex = "ff".repeat(32);
  await assert.rejects(engine.build(request), /creator fee account is spent or unavailable/);
});
