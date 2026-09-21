import {
  Kcc20BuilderError,
  assertSnapshotFresh,
  assertUniqueSources,
  buildFeeTicketBurnOperation,
  buildFeeTicketCreateOperation,
  buildFeeTicketRootDeployOperation,
  buildFeeTicketRootUpdateOperation,
  buildFeeTicketTransferOperation,
  buildKcc20CancelOperation,
  buildKcc20FillOperation,
  buildKcc20MintAvailabilityOperation,
  buildKcc20MintTokenOperation,
  buildKcc20OrderOperation,
  buildKcc20SweepOperation,
  buildKcc20TransferTokenOperation,
  buildKcc20UnwrapTokenOperationFromSnapshot,
  buildKcc20VerifyTokenOperation,
  buildKcc20WrapTokenOperationFromSnapshot,
  bytesToHex,
  createKcc20PsktBuilderEngine,
  hexToBytes,
  normalizeKcc20IndexedUtxos,
} from "../dist/index.js";

if (bytesToHex(hexToBytes("0x00ff")) !== "00ff") {
  throw new Error("hex roundtrip failed");
}

assertUniqueSources({
  walletUtxos: [
    {
      txidHex: "a".repeat(64),
      vout: 0,
      address: "kaspatest:source",
      amountSompi: "1",
    },
  ],
});

assertSnapshotFresh({
  snapshotId: "fresh",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

let staleRejected = false;
try {
  assertSnapshotFresh({
    snapshotId: "stale",
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
} catch (error) {
  staleRejected =
    error instanceof Kcc20BuilderError && error.code === "STALE_SOURCE";
}

if (!staleRejected) {
  throw new Error("stale source snapshot was accepted");
}

let backendOnlyRejected = false;
try {
  await createKcc20PsktBuilderEngine({ wasm: {}, artifacts: {} }).build({
    schema: "kcc20-in-process-pskt-builder-input/v1",
    request: { builderKey: "kcc20orderbook.matcher-settle-crossed" },
  });
} catch (error) {
  backendOnlyRejected =
    error instanceof Error && error.message.includes("backend-only");
}

if (!backendOnlyRejected) {
  throw new Error("shared builder accepted a backend-only matcher operation");
}

const feeTicketRootDeploy = buildFeeTicketRootDeployOperation(
  {
    walletAddress: "kaspatest:qwallet",
    kcc20Owner: "1".repeat(64),
  },
  {
    utilityTokenId: "2".repeat(64),
    utilityTokenAmount: "100000000",
    discountBps: 500,
    supportedMarketIds: ["3".repeat(64)],
  },
  { network: "testnet-10", requestId: "smoke-fee-ticket-root-deploy" },
);

if (
  feeTicketRootDeploy.payload.signing?.builderKey !== "fee-ticket.deploy-root"
) {
  throw new Error("FeeTicket root deploy operation used the wrong builder");
}
if (
  feeTicketRootDeploy.payload.params.rootOwner !== "1".repeat(64) ||
  feeTicketRootDeploy.payload.params.utilityTokenId !== "2".repeat(64) ||
  feeTicketRootDeploy.payload.params.utilityTokenAmount !== "100000000"
) {
  throw new Error("FeeTicket root deploy operation params were not preserved");
}

const verify = buildKcc20VerifyTokenOperation(
  {
    walletAddress: "kaspatest:qwallet",
    kcc20Owner: "1".repeat(64),
  },
  {
    covenantId: "2".repeat(64),
    activeTokenUtxo: {
      txidHex: "3".repeat(64),
      vout: 0,
      address: "kaspatest:qtoken",
      amountSompi: "100000000",
    },
    deployReceipt: {
      stateAmount: "0",
      owner: "1".repeat(64),
      ownerScheme: 0,
      extensionCommitment: "4".repeat(64),
      isMintAuthority: true,
      decimals: "8",
      mintPolicy: 2,
      extension: {
        mintPriceSompi: "100000000",
        protocolFeeBps: 200,
        remainingSupply: "1000000000",
      },
    },
  },
  { network: "testnet-10", requestId: "smoke-verify" },
);

if (
  verify.payload.signing?.builderKey !== "kcc20.reveal-token" ||
  verify.payload.params.revealMode !== "mint" ||
  verify.payload.params.tokenAmount !== "100000000"
) {
  throw new Error("verify operation did not calculate the reveal mint locally");
}

const mintAvailability = buildKcc20MintAvailabilityOperation(
  {
    walletAddress: "kaspatest:qwallet",
    kcc20Owner: "1".repeat(64),
  },
  {
    covenantId: "2".repeat(64),
    active: true,
    activeMinterUtxo: {
      txidHex: "3".repeat(64),
      vout: 1,
    },
    activeMinterUtxos: [
      {
        txidHex: "3".repeat(64),
        vout: 1,
      },
      {
        txidHex: "4".repeat(64),
        vout: 2,
      },
    ],
  },
  { network: "testnet-10", requestId: "smoke-mint-availability" },
);

if (
  mintAvailability.payload.signing?.builderKey !==
    "kcc20.set-public-mint-active" ||
  mintAvailability.payload.params.active !== true ||
  mintAvailability.payload.sourceRequirements[0]?.outpoints?.length !== 2
) {
  throw new Error(
    "mint availability operation did not preserve its local source plan",
  );
}

const canonicalId = "5".repeat(64);
const marketId = "6".repeat(64);
const owner = "1".repeat(64);
const tokenSnapshot = normalizeKcc20IndexedUtxos([
  {
    txidHex: "7".repeat(64),
    vout: 0,
    address: "kaspatest:qminter",
    amountSompi: "30000000",
    covenantId: canonicalId,
    state: {
      isMintAuthority: true,
      remainingSupply: "1000000000",
      ownerScheme: 0,
      ownerIdentifier: owner,
    },
  },
  {
    txidHex: "8".repeat(64),
    vout: 1,
    address: "kaspatest:qholder",
    amountSompi: "30000000",
    covenantId: canonicalId,
    state: {
      amount: "300000000",
      ownerScheme: 0,
      ownerIdentifier: owner,
    },
  },
  {
    txidHex: "b".repeat(64),
    vout: 2,
    address: "kaspatest:qreserve",
    amountSompi: "30000000",
    covenantId: canonicalId,
    state: {
      amount: "300000000",
      ownerScheme: 4,
      ownerIdentifier: marketId,
    },
  },
]);

const mint = buildKcc20MintTokenOperation(
  { walletAddress: "kaspatest:qwallet", kcc20Owner: owner },
  {
    token: {
      covenantId: canonicalId,
      decimals: 8,
      mintPolicy: {
        mintable: true,
        policy: "controlled",
        remainingSupply: "1000000000",
      },
    },
    tokenAmount: "1.5",
    activeUtxos: tokenSnapshot,
  },
  { network: "testnet-10", requestId: "smoke-mint" },
);
if (
  mint.payload.signing?.builderKey !== "kcc20.mint" ||
  mint.payload.params.tokenAmount !== "150000000" ||
  mint.payload.params.activeMinterUtxo?.outpoint !== `${"7".repeat(64)}:0`
) {
  throw new Error("mint operation did not resolve and scale its local source");
}

const transfer = buildKcc20TransferTokenOperation(
  { walletAddress: "kaspatest:qwallet", kcc20Owner: owner },
  {
    token: { covenantId: canonicalId, decimals: 8 },
    tokenAmount: "2",
    recipientOwner: "9".repeat(64),
    activeUtxos: tokenSnapshot,
  },
  { network: "testnet-10", requestId: "smoke-transfer" },
);
if (
  transfer.payload.signing?.builderKey !== "kcc20.transfer" ||
  transfer.payload.params.tokenAmount !== "200000000" ||
  transfer.payload.params.activeHolderUtxo?.outpoint !== `${"8".repeat(64)}:1`
) {
  throw new Error("transfer operation did not resolve its local holder source");
}

const wrapperSnapshot = normalizeKcc20IndexedUtxos([
  {
    txidHex: "a".repeat(64),
    vout: 2,
    address: "kaspatest:qwrapper",
    amountSompi: "30000000",
    covenantId: marketId,
    state: { enabled: true },
  },
]);
const wrap = buildKcc20WrapTokenOperationFromSnapshot(
  { walletAddress: "kaspatest:qwallet", kcc20Owner: owner },
  {
    canonicalCovenantId: canonicalId,
    tokenDecimals: 8,
    wrappedMarketId: marketId,
    tokenAmount: "1",
    wrapper: {
      wrapperId: marketId,
      marketId,
      canonicalTokenId: canonicalId,
      contractCanonicalTokenId: canonicalId,
      activeCovenantId: marketId,
      wrapperAddress: "kaspatest:qwrapper",
      enabled: true,
    },
    canonicalTokenUtxos: tokenSnapshot,
    wrapperUtxos: wrapperSnapshot,
  },
  { network: "testnet-10", requestId: "smoke-wrap" },
);
if (
  wrap.payload.signing?.builderKey !== "kcc20wrapper.wrap" ||
  wrap.payload.params.tokenAmount !== "100000000" ||
  wrap.payload.params.activeWrapperUtxo?.outpoint !== `${"a".repeat(64)}:2`
) {
  throw new Error("wrap operation did not resolve its local sources");
}

const askOneOutpoint = `${"c".repeat(64)}:0`;
const askTwoOutpoint = `${"d".repeat(64)}:1`;
const wrappedSnapshot = normalizeKcc20IndexedUtxos([
  {
    txidHex: "e".repeat(64),
    vout: 0,
    address: "kaspatest:qmarket",
    amountSompi: "30000000",
    state: { mode: 1, canonicalTokenId: canonicalId, amount: "0" },
  },
  {
    txidHex: "f".repeat(64),
    vout: 1,
    address: "kaspatest:qwrappedholder",
    amountSompi: "30000000",
    state: {
      mode: 0,
      canonicalTokenId: canonicalId,
      amount: "400000000",
      identifierType: 0,
      ownerIdentifier: owner,
    },
  },
  ...[
    ["c", 0, "qaskone"],
    ["d", 1, "qasktwo"],
  ].map(([hex, vout, address]) => ({
    txidHex: String(hex).repeat(64),
    vout,
    address: `kaspatest:${address}`,
    amountSompi: "30000000",
    state: {
      mode: 2,
      canonicalTokenId: canonicalId,
      amount: "100000000",
      unitPriceSompi: "100000000",
      priceScale: "100000000",
      identifierType: 0,
      ownerIdentifier: owner,
    },
  })),
]);
const tradingContext = {
  canonicalCovenantId: canonicalId,
  tokenDecimals: 8,
  wrapper: {
    wrapperId: marketId,
    marketId,
    canonicalTokenId: canonicalId,
    contractCanonicalTokenId: canonicalId,
    activeCovenantId: marketId,
    enabled: true,
  },
  wrappedTokenUtxos: wrappedSnapshot,
};
const wallet = { walletAddress: "kaspatest:qwallet", kcc20Owner: owner };
const operationOptions = { network: "testnet-10" };

const order = buildKcc20OrderOperation(
  wallet,
  tradingContext,
  {
    wrappedMarketId: marketId,
    side: "sell",
    tokenAmount: "1",
    unitPriceSompi: "100000000",
  },
  operationOptions,
);
if (
  order.payload.signing?.builderKey !== "kcc20orderbook.create-ask" ||
  order.payload.params.activeWrappedHolderUtxo?.outpoint !==
    `${"f".repeat(64)}:1`
) {
  throw new Error("create-order operation did not resolve local sources");
}

const fill = buildKcc20FillOperation(
  wallet,
  tradingContext,
  {
    wrappedMarketId: marketId,
    side: "buy",
    targetOrderId: askOneOutpoint,
    tokenAmount: "1",
    unitPriceSompi: "100000000",
  },
  operationOptions,
);
if (
  fill.payload.signing?.builderKey !== "kcc20orderbook.fill-ask" ||
  fill.payload.params.activeTargetOrderUtxo?.outpoint !== askOneOutpoint
) {
  throw new Error("fill operation did not resolve the selected local order");
}

const sweep = buildKcc20SweepOperation(
  wallet,
  tradingContext,
  {
    wrappedMarketId: marketId,
    side: "buy",
    tokenAmount: "2",
    mode: "market",
    expectedFills: [
      {
        orderId: askOneOutpoint,
        tokenAmount: "100000000",
        unitPriceSompi: "100000000",
      },
      {
        orderId: askTwoOutpoint,
        tokenAmount: "100000000",
        unitPriceSompi: "100000000",
      },
    ],
    grossSompi: "200000000",
    protocolFeeSompi: "400000",
    buyerPaysSompi: "200400000",
    sellerReceivesSompi: "199600000",
  },
  operationOptions,
);
if (
  sweep.payload.signing?.builderKey !== "kcc20orderbook.sweep-asks" ||
  sweep.payload.params.activeTargetOrderUtxos?.length !== 2
) {
  throw new Error("sweep operation did not resolve all local order sources");
}

const cancel = buildKcc20CancelOperation(
  wallet,
  tradingContext,
  {
    wrappedMarketId: marketId,
    side: "ask",
    targetOrderId: askOneOutpoint,
  },
  operationOptions,
);
if (
  cancel.payload.signing?.builderKey !== "kcc20orderbook.cancel-ask" ||
  cancel.payload.params.activeTargetOrderUtxo?.outpoint !== askOneOutpoint
) {
  throw new Error("cancel operation did not resolve its owned order");
}

const unwrap = buildKcc20UnwrapTokenOperationFromSnapshot(
  wallet,
  {
    canonicalCovenantId: canonicalId,
    tokenDecimals: 8,
    wrappedMarketId: marketId,
    tokenAmount: "1",
    wrapper: tradingContext.wrapper,
    canonicalTokenUtxos: tokenSnapshot,
    wrappedTokenUtxos: wrappedSnapshot,
    wrapperUtxos: wrapperSnapshot,
  },
  operationOptions,
);
if (
  unwrap.payload.signing?.builderKey !== "kcc20wrapper.unwrap" ||
  unwrap.payload.params.activeReserveUtxo?.outpoint !== `${"b".repeat(64)}:2`
) {
  throw new Error(
    "unwrap operation did not resolve holder and reserve sources",
  );
}

const feeRoot = {
  configured: true,
  enabled: true,
  rootId: "1".repeat(64),
  rootOwner: owner,
  utilityTokenId: "2".repeat(64),
  utilityTokenAmount: "100000000",
  discountBps: 500,
  supportedMarketIds: [marketId],
  batchCreateSupported: true,
  maxTicketBatchQuantity: 2,
};
const feeRootSnapshot = normalizeKcc20IndexedUtxos([
  {
    txidHex: "3".repeat(64),
    vout: 0,
    address: "kaspatest:qfeeroot",
    amountSompi: "30000000",
    state: { mode: 1, ownerIdentifier: owner },
  },
  {
    txidHex: "4".repeat(64),
    vout: 1,
    address: "kaspatest:qfeeticket",
    amountSompi: "30000000",
    state: { mode: 2, ownerIdentifier: owner },
  },
]);
const utilitySnapshot = normalizeKcc20IndexedUtxos([
  {
    txidHex: "5".repeat(64),
    vout: 0,
    address: "kaspatest:qutility",
    amountSompi: "30000000",
    state: {
      amount: "300000000",
      ownerScheme: 0,
      ownerIdentifier: owner,
    },
  },
]);
const feeTicketCreate = buildFeeTicketCreateOperation(
  wallet,
  {
    root: feeRoot,
    quantity: 2,
    rootUtxos: feeRootSnapshot,
    utilityTokenUtxos: utilitySnapshot,
  },
  operationOptions,
);
const ticketOutpoint = `${"4".repeat(64)}:1`;
const feeTicketBurn = buildFeeTicketBurnOperation(
  wallet,
  {
    root: feeRoot,
    ticketOutpoints: [ticketOutpoint],
    rootUtxos: feeRootSnapshot,
  },
  operationOptions,
);
const feeTicketTransfer = buildFeeTicketTransferOperation(
  wallet,
  {
    root: feeRoot,
    recipientOwner: "9".repeat(64),
    ticketOutpoints: [ticketOutpoint],
    rootUtxos: feeRootSnapshot,
  },
  operationOptions,
);
const feeTicketUpdate = buildFeeTicketRootUpdateOperation(
  wallet,
  { root: feeRoot, discountBps: 600, rootUtxos: feeRootSnapshot },
  operationOptions,
);
if (
  feeTicketCreate.payload.signing?.builderKey !==
    "fee-ticket.create-from-utility-burn" ||
  feeTicketBurn.payload.signing?.builderKey !== "fee-ticket.burn" ||
  feeTicketTransfer.payload.signing?.builderKey !== "fee-ticket.transfer" ||
  feeTicketUpdate.payload.signing?.builderKey !==
    "fee-ticket.update-denomination"
) {
  throw new Error("one or more FeeTicket operations used the wrong builder");
}

console.log("shared package smoke test passed");
