import { buildStandaloneFillFeeQuote } from "@kaspacom/kcc20-tx-builder/trade-fee";
import {
  buildKcc20ScriptForState,
  mintExtensionCommitment,
} from "@kaspacom/kcc20-tx-builder/abi";
import {
  buildKcc20OrderbookScriptForState,
  buildKcc20WrapperScriptForState,
  buildKcc20FeeTicketScriptForState,
} from "@kaspacom/kcc20-tx-builder/sale-common";
import type { Kcc20IndexedCovenantUtxo } from "@kaspacom/kcc20-tx-builder/action-source-resolver";
import {
  createBuilder,
  deployOperation,
  network,
  type Runtime,
  type Operation,
} from "./build.ts";
import { fixture, owner, recipient } from "./fixture.ts";
import { recipes } from "./recipes.ts";

// These are independent synthetic source snapshots, not a simulated chain ledger.
// Never broadcast their transactions or fund their public test-vector addresses.
export async function recipeFixtures(
  wasm: Runtime,
  loadArtifact: (key: string) => Promise<unknown>,
) {
  const data = fixture(wasm);
  const build = createBuilder(wasm, data.sources, loadArtifact);
  const options = {
    network,
    createdAt: "2026-01-01T00:00:00.000Z",
    requestId: "offline-recipe",
  };
  const deploy = await build(deployOperation(data.wallet));
  const baseHolder = data.addDeploy(deploy);
  const tokenId = baseHolder.covenantId!;
  const marketId = "22".repeat(32),
    feeId = "33".repeat(32),
    zero = "00".repeat(32);
  const hex = (value: string) =>
    Uint8Array.from(value.match(/../g)!, (x) => parseInt(x, 16));
  const [native, wrapped, wrapper, fee] = await Promise.all(
    ["KCC20", "KCC20Orderbook", "KCC20Wrapper", "KCC20FeeTicket"].map(
      async (name) =>
        (await loadArtifact(`${name}.placeholder.json`)) as {
          script: number[];
        },
    ),
  );
  let sequence = 1;
  function add(
    script: Uint8Array,
    state: Record<string, unknown>,
    covenantId: string,
    amountSompi = "100000000",
  ): Kcc20IndexedCovenantUtxo {
    const scriptPublicKey = wasm.payToScriptHashScript(script);
    const address = wasm
      .addressFromScriptPublicKey(scriptPublicKey, network)!
      .toString();
    const txidHex = (sequence++).toString(16).padStart(64, "0");
    const row = {
      address,
      outpoint: { transactionId: txidHex, index: 0 },
      amount: BigInt(amountSompi),
      scriptPublicKey,
      covenantId,
      blockDaaScore: 1n,
      isCoinbase: false,
    };
    data.rows.set(address, [...(data.rows.get(address) ?? []), row]);
    return {
      txidHex,
      vout: 0,
      outpoint: `${txidHex}:0`,
      address,
      amountSompi,
      covenantId,
      state,
    };
  }
  function holder(amount: string, ownerIdentifier = owner, ownerScheme = 0) {
    const state = { ...baseHolder.state, amount, ownerIdentifier, ownerScheme };
    return add(
      buildKcc20ScriptForState(native, {
        ...state,
        owner: hex(ownerIdentifier),
        borrowScheme: 0,
        borrowGuard: hex(zero),
        extensionCommitment: hex(String(baseHolder.state!.extensionCommitment)),
      }),
      state,
      tokenId,
    );
  }
  const holders = [holder("50000"), holder("30000")];
  const reserve = holder("50000", marketId, 4);
  const wrapperState = {
    canonicalTokenId: tokenId,
    enabled: true,
    priceScale: "100",
  };
  const wrapperUtxo = add(
    buildKcc20WrapperScriptForState(wrapper.script, {
      ...wrapperState,
      canonicalTokenId: hex(tokenId),
    }),
    wrapperState,
    marketId,
  );
  const wrapperInfo = {
    wrapperId: marketId,
    marketId,
    canonicalTokenId: tokenId,
    contractCanonicalTokenId: tokenId,
    activeCovenantId: marketId,
    wrapperAddress: wrapperUtxo.address,
    enabled: true,
  };
  function orderbook(
    mode: number,
    amount: string,
    unitPriceSompi = "100000000",
  ) {
    const state = {
      canonicalTokenId: tokenId,
      ownerIdentifier: owner,
      ownerScheme: 0,
      identifierType: 0,
      amount,
      mode,
      unitPriceSompi,
      feeTicketId: zero,
      priceScale: "100",
    };
    return add(
      buildKcc20OrderbookScriptForState(wrapped.script, {
        ...state,
        canonicalTokenId: hex(tokenId),
        ownerIdentifier: hex(owner),
        feeTicketId: hex(zero),
        amount: BigInt(amount),
        unitPriceSompi: BigInt(unitPriceSompi),
      }),
      state,
      marketId,
      mode === 3 ? "3000000000" : "100000000",
    );
  }
  const root = orderbook(1, "0", "0");
  const wrappedHolders = [
    orderbook(0, "50000", "0"),
    orderbook(0, "30000", "0"),
  ];
  const asks = [orderbook(2, "100"), orderbook(2, "100")];
  const bids = [orderbook(3, "100"), orderbook(3, "100")];
  const context = {
    canonicalCovenantId: tokenId,
    tokenDecimals: 2,
    wrapper: wrapperInfo,
    wrappedTokenUtxos: [root, ...wrappedHolders, ...asks, ...bids],
  };
  const rootInfo = {
    configured: true,
    enabled: true,
    rootId: feeId,
    rootOwner: owner,
    utilityTokenId: tokenId,
    utilityTokenAmount: "100",
    discountBps: 500,
    supportedMarketIds: [marketId],
    batchCreateSupported: true,
    maxTicketBatchQuantity: 2,
  };
  function ticket(mode: number) {
    const state = {
      ownerIdentifier: owner,
      ownerScheme: 0,
      mode,
      utilityTokenId: tokenId,
      denomination: "100",
    };
    return add(
      buildKcc20FeeTicketScriptForState(fee.script, {
        ...state,
        ownerIdentifier: hex(owner),
        utilityTokenId: hex(tokenId),
      }),
      state,
      feeId,
    );
  }
  const rootUtxos = [ticket(1), ticket(2)];
  const publicDeploy = await build(
    recipes.deploy(
      data.wallet,
      {
        ticker: "MINT",
        tokenName: "Public mint fixture",
        decimals: 2,
        maxSupply: "1000",
        premintSupply: "0",
        mintPolicy: "public",
        mintLaneCount: 1,
        mintPricePerTokenSompi: "0",
      },
      options,
    ),
  );
  const extension = {
    ...publicDeploy.metadata.extension,
    publicMintActive: true,
  };
  const binaryExtension = { ...extension };
  for (const key of [
    "creator",
    "ticker",
    "name",
    "treasury",
    "protocolFeeRecipient",
    "holderExtensionCommitment",
  ])
    binaryExtension[key] = hex(extension[key]);
  const commitment = mintExtensionCommitment(binaryExtension);
  const minterState = {
    ownerIdentifier: owner,
    ownerScheme: 0,
    amount: "0",
    isMintAuthority: true,
    mintPolicy: 2,
    remainingSupply: extension.remainingSupply,
    publicMintActive: true,
    extension,
    extensionCommitment: Array.from(commitment as Uint8Array, (x) =>
      x.toString(16).padStart(2, "0"),
    ).join(""),
  };
  const minter = add(
    buildKcc20ScriptForState(native, {
      amount: 0n,
      owner: hex(owner),
      ownerScheme: 0,
      borrowScheme: 0,
      borrowGuard: hex(zero),
      extensionCommitment: commitment,
    }),
    minterState,
    publicDeploy.metadata.covenantId,
  );
  const wallet = data.wallet;
  const publicWallet = {
    kcc20Owner: recipient,
    walletAddress: new wasm.XOnlyPublicKey(recipient)
      .toAddress(network)
      .toString(),
  };
  data.rows.set(publicWallet.walletAddress, [
    {
      ...data.rows.get(wallet.walletAddress)![0],
      address: publicWallet.walletAddress,
      outpoint: { transactionId: "ef".repeat(32), index: 0 },
      scriptPublicKey: wasm.payToAddressScript(publicWallet.walletAddress),
    },
  ]);
  // Real argument tuples: callable directly in either frontend or backend code.
  function sweepQuote(side: "buy" | "sell") {
    const quote = buildStandaloneFillFeeQuote({
      side,
      tokenAmount: "100",
      unitPriceSompi: "100000000",
      priceScale: "100",
      feeTicketApplied: false,
    });
    return {
      grossSompi: (2n * BigInt(quote.grossSompi)).toString(),
      protocolFeeSompi: (2n * BigInt(quote.protocolFeeSompi)).toString(),
      buyerPaysSompi: (2n * BigInt(quote.buyerPaysSompi!)).toString(),
      sellerReceivesSompi: (2n * BigInt(quote.sellerReceivesSompi!)).toString(),
    };
  }
  const args = {
    deploy: [
      wallet,
      {
        ticker: "DEMO",
        tokenName: "Example token",
        decimals: 2,
        maxSupply: "1000",
        premintSupply: "1000",
        mintPolicy: "fixed",
        mintPricePerTokenSompi: "0",
      },
      options,
    ],
    transfer: [
      wallet,
      {
        token: { covenantId: tokenId, decimals: 2 },
        activeUtxos: holders,
        recipientOwner: recipient,
        tokenAmount: "1.00",
      },
      options,
    ],
    mint: [
      wallet,
      {
        token: {
          covenantId: minter.covenantId!,
          decimals: 2,
          mintPolicy: {
            mintable: true,
            policy: "public",
            remainingSupply: extension.remainingSupply,
          },
        },
        activeUtxos: [minter],
        tokenAmount: "1.00",
      },
      options,
    ],
    publicMint: [
      publicWallet,
      {
        token: {
          covenantId: minter.covenantId!,
          decimals: 2,
          mintPolicy: {
            mintable: true,
            policy: "public",
            remainingSupply: extension.remainingSupply,
            publicMintActive: true,
          },
        },
        activeUtxos: [minter],
        tokenAmount: "1.00",
      },
      options,
    ],
    buyOrder: [
      wallet,
      context,
      {
        wrappedMarketId: marketId,
        side: "buy",
        tokenAmount: "1.00",
        unitPriceSompi: "100000000",
      },
      options,
    ],
    fillBid: [
      wallet,
      context,
      {
        wrappedMarketId: marketId,
        side: "sell",
        targetOrderId: bids[0].outpoint!,
        tokenAmount: "1.00",
        unitPriceSompi: "100000000",
      },
      options,
    ],
    sweepBids: [
      wallet,
      context,
      {
        wrappedMarketId: marketId,
        side: "sell",
        tokenAmount: "2.00",
        mode: "market",
        expectedFills: bids.map((x) => ({
          orderId: x.outpoint!,
          tokenAmount: "100",
          unitPriceSompi: "100000000",
        })),
        ...sweepQuote("sell"),
      },
      options,
    ],
    cancelBid: [
      wallet,
      context,
      {
        wrappedMarketId: marketId,
        side: "bid",
        targetOrderId: bids[0].outpoint!,
      },
      options,
    ],
    mintAvailability: [
      wallet,
      {
        covenantId: minter.covenantId!,
        active: false,
        activeMinterUtxo: minter,
        activeMinterUtxos: [minter],
      },
      options,
    ],
    consolidate: [
      wallet,
      {
        token: { covenantId: tokenId, decimals: 2 },
        activeUtxos: holders,
        sourceOutpoints: holders.map((x) => x.outpoint!),
      },
      options,
    ],
    reveal: [
      wallet,
      { covenantId: tokenId, activeTokenUtxo: holders[0], decimals: 2 },
      options,
    ],
    deployMarket: [
      wallet,
      {
        canonicalCovenantId: tokenId,
        tokenDecimals: 2,
        wrappedRootAmount: "0",
      },
      options,
    ],
    wrap: [
      wallet,
      {
        canonicalCovenantId: tokenId,
        tokenDecimals: 2,
        wrappedMarketId: marketId,
        tokenAmount: "1.00",
        wrapper: wrapperInfo,
        canonicalTokenUtxos: holders,
        wrapperUtxos: [wrapperUtxo],
      },
      options,
    ],
    unwrap: [
      wallet,
      {
        canonicalCovenantId: tokenId,
        tokenDecimals: 2,
        wrappedMarketId: marketId,
        tokenAmount: "1.00",
        wrapper: wrapperInfo,
        canonicalTokenUtxos: [reserve],
        wrappedTokenUtxos: wrappedHolders,
        wrapperUtxos: [wrapperUtxo],
      },
      options,
    ],
    order: [
      wallet,
      context,
      {
        wrappedMarketId: marketId,
        side: "sell",
        tokenAmount: "1.00",
        unitPriceSompi: "100000000",
      },
      options,
    ],
    fill: [
      wallet,
      context,
      {
        wrappedMarketId: marketId,
        side: "buy",
        targetOrderId: asks[0].outpoint!,
        tokenAmount: "1.00",
        unitPriceSompi: "100000000",
      },
      options,
    ],
    sweep: [
      wallet,
      context,
      {
        wrappedMarketId: marketId,
        side: "buy",
        tokenAmount: "2.00",
        mode: "market",
        expectedFills: asks.map((x) => ({
          orderId: x.outpoint!,
          tokenAmount: "100",
          unitPriceSompi: "100000000",
        })),
        ...sweepQuote("buy"),
      },
      options,
    ],
    cancel: [
      wallet,
      context,
      {
        wrappedMarketId: marketId,
        side: "ask",
        targetOrderId: asks[0].outpoint!,
      },
      options,
    ],
    consolidateWrapped: [
      wallet,
      context,
      wrappedHolders.map((x) => x.outpoint!),
      options,
    ],
    deployFeeTicketRoot: [
      wallet,
      { utilityTokenId: tokenId, utilityTokenAmount: "100", discountBps: 500 },
      options,
    ],
    updateFeeTicketRoot: [
      wallet,
      { root: rootInfo, rootUtxos, utilityTokenAmount: "200" },
      options,
    ],
    createFeeTicket: [
      wallet,
      { root: rootInfo, quantity: 1, rootUtxos, utilityTokenUtxos: holders },
      options,
    ],
    burnFeeTicket: [
      wallet,
      { root: rootInfo, rootUtxos, ticketOutpoints: [rootUtxos[1].outpoint!] },
      options,
    ],
    transferFeeTicket: [
      wallet,
      {
        root: rootInfo,
        rootUtxos,
        ticketOutpoints: [rootUtxos[1].outpoint!],
        recipientOwner: recipient,
      },
      options,
    ],
  } satisfies { [K in keyof typeof recipes]: Parameters<(typeof recipes)[K]> };
  function operation(name: keyof typeof recipes): Operation {
    const fn = recipes[name] as (...values: any[]) => Operation;
    return fn(...args[name]);
  }
  return { ...data, args, operation, build, minter, context, bids, options };
}
