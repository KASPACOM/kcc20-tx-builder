import { readFile } from "node:fs/promises";
import {
  KCC20_ARTIFACT_SCRIPT_SHA256,
  Kcc20BuilderError,
  assertKcc20ArtifactScriptHash,
  isKcc20ArtifactKey,
  assertSnapshotFresh,
  assertUniqueSources,
  buildFeeTicketBurnOperation,
  buildFeeTicketCreateOperation,
  buildFeeTicketRootDeployOperation,
  buildFeeTicketRootUpdateOperation,
  buildFeeTicketTransferOperation,
  buildKcc20CancelOperation,
  buildKcc20DeployTokenOperation,
  buildKcc20FillOperation,
  buildKcc20MintAvailabilityOperation,
  buildKcc20MintTokenOperation,
  buildKcc20NativeConsolidationOperation,
  buildKcc20OrderOperation,
  buildKcc20SweepOperation,
  buildKcc20TransferTokenOperation,
  buildKcc20UnwrapTokenOperationFromSnapshot,
  buildKcc20VerifyTokenOperation,
  buildKcc20WrappedConsolidationOperation,
  buildKcc20WrapperMarketDeployOperation,
  buildKcc20WrapTokenOperationFromSnapshot,
  buildKcc20PaidMintAmountQuote,
  bytesToHex,
  calculateKcc20OrderTotalSompi,
  calculateKcc20MaximumBuyerGrossSompi,
  calculateKcc20MaximumBuyTokenBaseUnits,
  createKcc20PsktBuilderEngine,
  hexToBytes,
  normalizeKcc20IndexedUtxos,
  kcc20MinimumSafePaidMintAmount,
  kcc20PaidMintCapacityMeetsMinimumGross,
  kcc20SupportedDisplayScales,
  selectConsolidationBatch,
  selectOwnerNativeHolderUtxo,
  selectOwnerWrappedHolderUtxosForSweep,
  planKcc20LadderLimitOrders,
  selectFeeTicketOutpoints,
  selectOwnerFeeTicketUtxos,
  resolveKcc20MintAvailabilitySources,
  splitKcc20MintSupply,
} from "../dist/index.js";

for (const key of Object.keys(KCC20_ARTIFACT_SCRIPT_SHA256)) {
  if (!isKcc20ArtifactKey(key)) {
    throw new Error(`published KCC20 artifact key was not recognized: ${key}`);
  }
  const artifact = JSON.parse(
    await readFile(new URL(`../artifacts/${key}`, import.meta.url), "utf8"),
  );
  assertKcc20ArtifactScriptHash(key, artifact);
}
if (isKcc20ArtifactKey("unknown.placeholder.json")) {
  throw new Error("unknown KCC20 artifact key was accepted");
}

const supportedDisplayScales = kcc20SupportedDisplayScales();
if (
  supportedDisplayScales.length !== 9 ||
  supportedDisplayScales[0] !== 1n ||
  supportedDisplayScales[8] !== 100_000_000n
) {
  throw new Error("supported KCC20 display scales are invalid");
}

if (bytesToHex(hexToBytes("0x00ff")) !== "00ff") {
  throw new Error("hex roundtrip failed");
}

if (
  splitKcc20MintSupply(10n, 3n).join(",") !== "4,3,3" ||
  splitKcc20MintSupply(10n, 10n).some((value) => value !== 1n)
) {
  throw new Error("mint lane supply partition drifted");
}
try {
  splitKcc20MintSupply(2n, 3n);
  throw new Error("mint lane supply underflow was accepted");
} catch (error) {
  if (!String(error).includes("cover every mint lane")) throw error;
}

const exactOrder = calculateKcc20OrderTotalSompi(
  "7956.04412131",
  "169000000",
  8,
);
if (
  exactOrder?.roundedTokenAmountBaseUnits !== "795604412100" ||
  exactOrder.totalSompi !== "1344571456449" ||
  !exactOrder.roundedDown
) {
  throw new Error("exact order amount calculation drifted");
}

const paidMintQuote = buildKcc20PaidMintAmountQuote({
  tokenAmount: 217_391_305n,
  unitPriceSompi: 23_000_000n,
  priceScale: 100_000_000n,
  minimumGrossSompi: 55_000_000n,
});
if (
  paidMintQuote?.adjustedTokenAmount !== 217_391_400n ||
  paidMintQuote.grossSompi !== 50_000_022n ||
  !paidMintQuote.belowMinimumGross
) {
  throw new Error("paid-mint exact-sompi quote drifted");
}
if (
  kcc20MinimumSafePaidMintAmount({
    unitPriceSompi: 23_000_000n,
    priceScale: 100_000_000n,
    minimumGrossSompi: 55_000_000n,
  }) !== 239_130_500n
) {
  throw new Error("paid-mint minimum safe amount drifted");
}
if (
  !kcc20PaidMintCapacityMeetsMinimumGross({
    remainingTokenAmount: 200n,
    unitPriceSompi: 25_000_000n,
    priceScale: 100n,
  }) ||
  kcc20PaidMintCapacityMeetsMinimumGross({
    remainingTokenAmount: 199n,
    unitPriceSompi: 25_000_000n,
    priceScale: 100n,
  })
) {
  throw new Error("paid-mint capacity display-scale calculation drifted");
}
if (
  calculateKcc20MaximumBuyerGrossSompi({
    availableSompi: 100_000_000n,
    protocolFeeBps: 200,
  }) !== 50_000_000n ||
  calculateKcc20MaximumBuyTokenBaseUnits({
    availableSompi: 120_000_000n,
    networkReserveSompi: 20_000_000n,
    unitPriceSompi: 100_000_000n,
    priceScale: 100_000_000n,
    protocolFeeBps: 200,
  }) !== 50_000_000n
) {
  throw new Error("buyer budget sizing calculation drifted");
}

const ownerId = "9".repeat(64);
const canonicalTokenId = "8".repeat(64);
const indexedWithoutOutpoint = [
  {
    txidHex: "1".repeat(64),
    vout: 2,
    address: "kaspatest:holder-one",
    amountSompi: "100000000",
    state: {
      amount: "5",
      ownerIdentifier: ownerId,
      ownerScheme: 0,
      identifierType: 0,
      mode: 0,
      canonicalTokenId,
    },
  },
  {
    txidHex: "2".repeat(64),
    vout: 3,
    address: "kaspatest:holder-two",
    amountSompi: "100000000",
    state: {
      amount: "9",
      ownerIdentifier: ownerId,
      ownerScheme: 0,
      identifierType: 0,
      mode: 0,
      canonicalTokenId,
    },
  },
];
if (
  selectOwnerNativeHolderUtxo(
    indexedWithoutOutpoint,
    ownerId,
    "4",
    `${"1".repeat(64)}:2`,
  ) !== indexedWithoutOutpoint[0]
) {
  throw new Error("source resolution failed without a precomputed outpoint");
}
const sweepSources = selectOwnerWrappedHolderUtxosForSweep(
  indexedWithoutOutpoint,
  ownerId,
  ["8", "4"],
  canonicalTokenId,
);
if (
  sweepSources[0] !== indexedWithoutOutpoint[1] ||
  sweepSources[1] !== indexedWithoutOutpoint[0]
) {
  throw new Error("wrapped sweep source assignment drifted");
}
const explicitConsolidation = selectConsolidationBatch(
  indexedWithoutOutpoint,
  [`${"2".repeat(64)}:3`, `${"1".repeat(64)}:2`],
  8,
  "largest",
  2,
);
if (
  explicitConsolidation[0] !== indexedWithoutOutpoint[1] ||
  explicitConsolidation[1] !== indexedWithoutOutpoint[0]
) {
  throw new Error("explicit consolidation source order was not preserved");
}
const ladder = planKcc20LadderLimitOrders({
  tokenAmount: "1",
  baseUnitPriceSompi: "100000000",
  decimals: 8,
  count: 3,
  direction: "decrement",
  percent: 3,
  protocolFeeBps: 0,
});
if (ladder?.unitPriceSompi.join(",") !== "100000000,97000000,94090000") {
  throw new Error("ladder order planning drifted");
}
const selectedTickets = selectFeeTicketOutpoints(
  [
    { outpoint: `${"4".repeat(64)}:0`, amountSompi: "20" },
    { outpoint: `${"3".repeat(64)}:1`, amountSompi: "10" },
  ],
  1,
);
if (selectedTickets[0] !== `${"3".repeat(64)}:1`) {
  throw new Error("FeeTicket collateral selection drifted");
}
const ownerTicketUtxos = selectOwnerFeeTicketUtxos(
  [
    {
      txidHex: "8".repeat(64),
      vout: 0,
      address: "kaspatest:qfeeticket",
      amountSompi: "1000",
      state: { mode: 2, ticketOwner: "a".repeat(64) },
    },
    {
      txidHex: "7".repeat(64),
      vout: 0,
      address: "kaspatest:qfeeticket",
      amountSompi: "1000",
      state: { stateMode: "2", holderOwner: ownerId.toUpperCase() },
    },
    {
      txidHex: "6".repeat(64),
      vout: 0,
      address: "kaspatest:qfeeticket",
      amountSompi: "1000",
      state: { mode: 2, stateOwner: ownerId.toUpperCase() },
    },
  ],
  ownerId,
);
if (
  ownerTicketUtxos.map((utxo) => utxo.txidHex).join(",") !==
  `${"6".repeat(64)},${"7".repeat(64)}`
) {
  throw new Error("FeeTicket owner alias selection drifted");
}
const mintAvailabilitySources = resolveKcc20MintAvailabilitySources({
  publicMintControlSupported: true,
  activeUtxos: [
    {
      ...indexedWithoutOutpoint[0],
      state: {
        ...indexedWithoutOutpoint[0].state,
        isMintAuthority: true,
        mintPolicy: 2,
        publicMintActive: false,
      },
    },
  ],
  owner: ownerId,
  active: true,
});
if (mintAvailabilitySources.activeMinterUtxos.length !== 1) {
  throw new Error("mint availability source resolution drifted");
}

const decimalDeploy = buildKcc20DeployTokenOperation(
  { walletAddress: "kaspatest:qwallet", kcc20Owner: ownerId },
  {
    ticker: "abc",
    tokenName: "  Alpha   Coin  ",
    maxSupply: "1000000",
    premintSupply: "0",
    decimals: 2,
    mintPolicy: "public",
    mintLaneCount: 10,
    mintPricePerTokenSompi: "100000000",
  },
);
if (
  decimalDeploy.payload.params.decimals !== 2 ||
  decimalDeploy.payload.params.ticker !== "ABC" ||
  decimalDeploy.payload.params.tokenName !== "Alpha Coin" ||
  decimalDeploy.payload.params.deployTemplate.args.find(
    (argument) => argument.name === "displayScale",
  )?.value !== "100"
) {
  throw new Error("deploy decimals were not preserved in the covenant plan");
}
let unsafePaidDeployRejected = false;
try {
  buildKcc20DeployTokenOperation(
    { walletAddress: "kaspatest:qwallet", kcc20Owner: ownerId },
    {
      maxSupply: "1",
      premintSupply: "0",
      decimals: 8,
      mintPolicy: "public",
      mintLaneCount: 1,
      mintPricePerTokenSompi: "1",
    },
  );
} catch (error) {
  unsafePaidDeployRejected =
    error instanceof Error && error.message.includes("minimum protocol fee");
}
if (!unsafePaidDeployRejected) {
  throw new Error("unsafe paid-mint deploy supply was accepted");
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
const wallet = { walletAddress: "kaspatest:qwallet", kcc20Owner: owner };
const operationOptions = { network: "testnet-10" };
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

const nativeConsolidationSnapshot = normalizeKcc20IndexedUtxos([
  ...tokenSnapshot,
  {
    txidHex: "9".repeat(64),
    vout: 3,
    address: "kaspatest:qholdertwo",
    amountSompi: "30000000",
    covenantId: canonicalId,
    state: {
      amount: "200000000",
      ownerScheme: 0,
      ownerIdentifier: owner,
    },
  },
]);
const nativeConsolidation = buildKcc20NativeConsolidationOperation(
  wallet,
  {
    token: { covenantId: canonicalId, decimals: 8 },
    activeUtxos: nativeConsolidationSnapshot,
    sourceOutpoints: [`${"8".repeat(64)}:1`, `${"9".repeat(64)}:3`],
  },
  operationOptions,
);
if (
  nativeConsolidation.payload.signing?.builderKey !==
    "kcc20.consolidate-holders" ||
  nativeConsolidation.payload.params.activeHolderUtxos?.length !== 2 ||
  nativeConsolidation.payload.params.tokenAmount !== "500000000"
) {
  throw new Error("native consolidation operation did not resolve its batch");
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
const wrapperDeploy = buildKcc20WrapperMarketDeployOperation(
  wallet,
  {
    canonicalCovenantId: canonicalId,
    tokenDecimals: 8,
    wrappedRootAmount: "0",
  },
  operationOptions,
);
if (
  wrapperDeploy.payload.signing?.builderKey !== "kcc20wrapper.deploy-market" ||
  wrapperDeploy.payload.params.priceScale !== "100000000"
) {
  throw new Error("wrapper market deploy operation did not preserve scale");
}

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

const bidOneOutpoint = `${"2".repeat(64)}:0`;
const bidTwoOutpoint = `${"3".repeat(64)}:1`;
const bidSnapshot = normalizeKcc20IndexedUtxos([
  ...wrappedSnapshot,
  ...[
    ["2", 0, "qbidone"],
    ["3", 1, "qbidtwo"],
  ].map(([hex, vout, address]) => ({
    txidHex: String(hex).repeat(64),
    vout,
    address: `kaspatest:${address}`,
    amountSompi: "30000000",
    state: {
      mode: 3,
      canonicalTokenId: canonicalId,
      amount: "100000000",
      unitPriceSompi: "100000000",
      priceScale: "100000000",
      identifierType: 0,
      ownerIdentifier: owner,
    },
  })),
]);
const bidContext = { ...tradingContext, wrappedTokenUtxos: bidSnapshot };
const buyOrder = buildKcc20OrderOperation(
  wallet,
  bidContext,
  {
    wrappedMarketId: marketId,
    side: "buy",
    tokenAmount: "1",
    unitPriceSompi: "100000000",
  },
  operationOptions,
);
const fillBid = buildKcc20FillOperation(
  wallet,
  bidContext,
  {
    wrappedMarketId: marketId,
    side: "sell",
    targetOrderId: bidOneOutpoint,
    tokenAmount: "1",
    unitPriceSompi: "100000000",
  },
  operationOptions,
);
const sweepBids = buildKcc20SweepOperation(
  wallet,
  bidContext,
  {
    wrappedMarketId: marketId,
    side: "sell",
    tokenAmount: "2",
    mode: "market",
    expectedFills: [
      {
        orderId: bidOneOutpoint,
        tokenAmount: "100000000",
        unitPriceSompi: "100000000",
      },
      {
        orderId: bidTwoOutpoint,
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
const cancelBid = buildKcc20CancelOperation(
  wallet,
  bidContext,
  {
    wrappedMarketId: marketId,
    side: "bid",
    targetOrderId: bidOneOutpoint,
  },
  operationOptions,
);
if (
  buyOrder.payload.signing?.builderKey !== "kcc20orderbook.create-bid" ||
  fillBid.payload.signing?.builderKey !== "kcc20orderbook.fill-bid" ||
  sweepBids.payload.signing?.builderKey !== "kcc20orderbook.sweep-bids" ||
  cancelBid.payload.signing?.builderKey !== "kcc20orderbook.cancel-bid"
) {
  throw new Error("one or more bid-side operations used the wrong builder");
}

const wrappedConsolidationSnapshot = normalizeKcc20IndexedUtxos([
  ...wrappedSnapshot,
  {
    txidHex: "a".repeat(64),
    vout: 4,
    address: "kaspatest:qwrappedholdertwo",
    amountSompi: "30000000",
    covenantId: marketId,
    state: {
      mode: 0,
      canonicalTokenId: canonicalId,
      amount: "200000000",
      identifierType: 0,
      ownerIdentifier: owner,
    },
  },
]);
const wrappedConsolidation = buildKcc20WrappedConsolidationOperation(
  wallet,
  { ...tradingContext, wrappedTokenUtxos: wrappedConsolidationSnapshot },
  [`${"f".repeat(64)}:1`, `${"a".repeat(64)}:4`],
  operationOptions,
);
if (
  wrappedConsolidation.payload.signing?.builderKey !==
    "kcc20orderbook.consolidate-holders" ||
  wrappedConsolidation.payload.params.activeWrappedHolderUtxos?.length !== 2 ||
  wrappedConsolidation.payload.params.tokenAmount !== "600000000"
) {
  throw new Error("wrapped consolidation operation did not resolve its batch");
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
