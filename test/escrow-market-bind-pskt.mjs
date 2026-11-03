import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blake3 } from "@noble/hashes/blake3";
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
  wrapper: "KCC20WrapperFeeV1", argentWrapper: "KCC20WrapperFeeArgentV2",
};
const globalArtifacts = Object.fromEntries(Object.entries(keys).map(([role, name]) => [
  role, JSON.parse(readFileSync(new URL(`../artifacts/${name}.placeholder.json`, import.meta.url))),
]));
const artifacts = globalArtifacts;
const wrapperV2 = JSON.parse(readFileSync(new URL("../artifacts/KCC20WrapperFeeV2.placeholder.json", import.meta.url)));
const native = JSON.parse(readFileSync(new URL("../artifacts/KCC20.placeholder.json", import.meta.url)));
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

function fixture(wrapperVersion = 1, creatorBps = 0) {
  const artifacts = { ...globalArtifacts, ...(wrapperVersion === 2 ? { wrapper: wrapperV2 } : {}) };
  const marketPolicy = { ...policy, creatorFeeBps: creatorBps,
    creatorAccountId: creatorBps ? "07".repeat(32) : "00".repeat(32) };
  const genesis = prepareKcc20FeeMarketGenesis({
    tokenId, feeTicketId: "00".repeat(32), priceScale: 1n,
    policy: marketPolicy, wrapperProfile: "native", artifacts,
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
        wrapperVersion, marketId, contractCanonicalTokenId: tokenId, feeTicketId: "00".repeat(32),
        priceScale: "1", wrapperProfile: "native", feePolicy: marketPolicy,
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
  let tokenEntry = null;
  let tokenAddress = null;
  if (creatorBps > 0) {
    const extension = Buffer.alloc(202); extension[0] = 1;
    Buffer.from(owner, "hex").copy(extension, 1); extension.writeBigInt64LE(1n,97);
    const commitment = blake3(Buffer.concat([Buffer.from("KASPACOM/KCC20/HOLDER/V1"), extension]));
    const tokenState = { amount: 10n, owner: Buffer.from(owner, "hex"), ownerScheme: 0,
      borrowScheme: 0, borrowGuard: new Uint8Array(32), extensionCommitment: commitment };
    const script = buildKcc20ScriptForState(native, tokenState);
    const spk = kw.payToScriptHashScript(script);
    tokenAddress = kw.addressFromScriptPublicKey(spk, "testnet-10").toString();
    tokenEntry = { outpoint: { transactionId: "0c".repeat(32), index: 0 }, amount: 70000000n,
      scriptPublicKey: spk, blockDaaScore: 0n, isCoinbase: false, covenantId: tokenId };
    const params = request.request.params;
    params.creatorTokenUtxo = { txidHex: tokenEntry.outpoint.transactionId, vout: 0,
      address: tokenAddress, amountSompiExact: "70000000", state: {
        stateAmount: "10", owner, ownerScheme: 0, borrowScheme: 0,
        borrowGuard: "00".repeat(32), extensionCommitment: hex(commitment) } };
    const consent = kcc20CreatorFeeConsent({ tokenId, marketId, feeTicketId: "00".repeat(32),
      priceScale: 1n, policy: marketPolicy });
    params.creatorEvidence = { contractCanonicalTokenId: tokenId, creatorOwner: owner,
      claimVerified: true, verificationStatus: "verified", classificationStatus: "matched",
      ownerScheme: 0, creatorConsentAvailable: true };
    params.creatorConsent = { creatorOwner: owner, signature: kw.signMessage({ message: consent.message, privateKey: key }) };
    params.creatorAccount = { accountId: marketPolicy.creatorAccountId };
    params.creatorHolderExtensionHex = hex(extension);
  }
  const engine = createKcc20PsktBuilderEngine({
    wasm: kw, artifacts: { ...artifactMap, "KCC20WrapperFeeV2.placeholder.json": wrapperV2, "KCC20.placeholder.json": native },
    rpcClientFactory: () => ({
      connect: async () => {}, disconnect: async () => {},
      getUtxosByAddresses: async ({ addresses }) => ({
        entries: addresses.includes(wallet) ? [fundingEntry] : addresses.includes(tokenAddress) ? [tokenEntry] : [wrapperEntry],
      }),
    }),
  });
  return { engine, request, wrapperEntry, fundingEntry, tokenEntry };
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

for (const rate of [0, 100, 500]) {
  test(`V2 activation with ${rate} creator bps preserves its proof token and principal`, async () => {
    const f = fixture(2, rate);
    const built = await f.engine.build(f.request);
    const tx = kw.Transaction.deserializeFromSafeJSON(built.psktTransactionJson);
    const entries = rate ? [f.wrapperEntry, f.tokenEntry, f.fundingEntry] : [f.wrapperEntry, f.fundingEntry];
    for (const script of built.scripts) {
      const signature = Buffer.from(kw.createInputSignature(tx, script.inputIndex, key, kw.SighashType.All), "hex");
      const args = new kw.ScriptBuilder({ flags: { covenantsEnabled: true } });
      for (const arg of script.signatureScript.args) {
        if (arg.type === "data") args.addData(Buffer.from(arg.hex, "hex"));
        else if (arg.type === "i64") args.addI64(BigInt(arg.value));
        else if (arg.type === "byte") args.addData(Uint8Array.of(arg.value));
        else if (arg.type === "signature") args.addData(Buffer.concat([Buffer.from(arg.prefixHex ?? "", "hex"), signature]));
        else throw new Error(`unsupported argument ${arg.type}`);
      }
      tx.inputs[script.inputIndex].signatureScript = kw.ScriptBuilder.fromScript(
        Buffer.from(script.scriptHex, "hex"), { flags: { covenantsEnabled: true } }
      ).encodePayToScriptHashSignatureScript(args.drain());
    }
    for (const input of built.signInputs) tx.inputs[input.index].signatureScript = kw.createInputSignature(tx, input.index, key, kw.SighashType.All);
    const json = JSON.parse(tx.serializeToSafeJSON());
    assert.equal(built.metadata.wrapperVersion, 2);
    assert.equal(json.inputs.length, rate ? 3 : 2);
    if (rate) {
      assert.equal(BigInt(json.outputs[2].value), 70000000n);
      assert.equal(tx.outputs[2].scriptPublicKey.script, f.tokenEntry.scriptPublicKey.script);
      assert.equal(tx.outputs[2].scriptPublicKey.version, f.tokenEntry.scriptPublicKey.version);
      assert.equal(json.outputs[2].covenant.covenantId, tokenId);
      assert.equal(json.outputs[2].covenant.authorizingInput, 1);
    }
    const mass = f.engine.protocol.calculateToccataV1NonContextualMass(tx, "activation").transactionMass;
    const storage = f.engine.protocol.calculateToccataStorageMass(tx, "activation");
    assert(mass <= 450000n && storage <= 450000n);
    assert(entries.reduce((sum,e)=>sum+e.amount,0n) > json.outputs.reduce((sum,o)=>sum+BigInt(o.value),0n));
    if (rate) {
      f.tokenEntry.covenantId = "ff".repeat(32);
      await assert.rejects(f.engine.build(f.request), /covenant/i);
    }
  });
}

test("V2 activation rejects missing proof, inconsistent metadata and forged consent", async () => {
  const f = fixture(2, 100), params = f.request.request.params;
  const source = params.creatorTokenUtxo;
  delete params.creatorTokenUtxo;
  await assert.rejects(f.engine.build(f.request), /canonical token holder input/);
  params.creatorTokenUtxo = source;
  const extension = params.creatorHolderExtensionHex;
  params.creatorHolderExtensionHex = "00".repeat(202);
  await assert.rejects(f.engine.build(f.request), /metadata differs/);
  params.creatorHolderExtensionHex = extension;
  params.creatorConsent.signature = kw.signMessage({ message: "another policy", privateKey: key });
  await assert.rejects(f.engine.build(f.request), /does not authorize/);
});
