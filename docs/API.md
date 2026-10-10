# API guide

The root module exports the APIs below. Generated declarations under `dist/`
are the exact reference for the installed version; source links explain the
operation-specific fields. This guide covers version `0.2.5`.

## Entry points

| API | Purpose | Reference |
| --- | --- | --- |
| `createKcc20PsktBuilderEngine(options)` | Reusable configured PSKT engine; supports the explicit backend-only opt-in. | [engine.ts](../src/engine.ts) |
| `buildKcc20Pskt(dependencies, input)` | Convenience wrapper that creates an engine for one in-process build. | [builder.ts](../src/builder.ts) |
| `KCC20_PSKT_BUILDER_INPUT_SCHEMA` | Schema required by the engine's in-process envelope. | [builder.ts](../src/builder.ts) |
| `KCC20_BUILDER_KEYS` | Declared user-operation builder keys. | [operations.ts](../src/operations.ts) |
| `BACKEND_ONLY_BUILDER_KEYS` | Builder keys restricted by the engine's backend-only guard. | [operations.ts](../src/operations.ts) |

`KaspaWasmRuntime` is a host-supplied capability object, not a bundled SDK.
`Kcc20SourceProvider.getSources` describes a host intent/source resolver;
it is distinct from the engine option `sourceProvider.getUtxosByAddresses`.
See [runtime.ts](../src/runtime.ts), [source-provider.ts](../src/source-provider.ts),
and [models.ts](../src/models.ts).

## Operation helpers

These helpers prepare wallet-operation intent or source selection. They do not
sign or broadcast and are not a substitute for a funded engine build.

| Family | Representative exports | Reference |
| --- | --- | --- |
| Deploy | `buildKcc20DeployTokenOperation`, `validateKcc20DeployToken` | [deploy-operation.ts](../src/deploy-operation.ts) |
| Token | `buildKcc20MintTokenOperation`, `buildKcc20TransferTokenOperation`, `buildKcc20NativeConsolidationOperation` | [token-operation.ts](../src/token-operation.ts) |
| Mint availability | `buildKcc20MintAvailabilityOperation` | [mint-availability-operation.ts](../src/mint-availability-operation.ts) |
| Verify | `buildKcc20VerifyTokenOperation` | [verify-operation.ts](../src/verify-operation.ts) |
| Wrapper | `buildKcc20WrapperMarketDeployOperation`, `buildKcc20WrapTokenOperationFromSnapshot`, `buildKcc20UnwrapTokenOperationFromSnapshot` | [wrapper-operation.ts](../src/wrapper-operation.ts) |
| Orders | `buildKcc20OrderOperation`, `buildKcc20FillOperation`, `buildKcc20SweepOperation`, `buildKcc20CancelOperation`, `buildKcc20WrappedConsolidationOperation` | [trading-operation.ts](../src/trading-operation.ts) |
| FeeTicket | `buildFeeTicketRootDeployOperation`, `buildFeeTicketRootUpdateOperation`, `buildFeeTicketCreateOperation`, `buildFeeTicketBurnOperation`, `buildFeeTicketTransferOperation` | [fee-ticket-operation.ts](../src/fee-ticket-operation.ts) |
| Wallet envelope | `buildKcc20WalletOperationFromPlan` | [wallet-operation.ts](../src/wallet-operation.ts) |

The shipped artifact set also contains `KCC20Vesting.placeholder.json`.
Its inclusion does not imply a dedicated vesting builder exists in
`KCC20_BUILDER_KEYS`.

## Calculations and sources

| Area | Exports | Reference |
| --- | --- | --- |
| Amounts | `parseKcc20DisplayAmountToBaseUnits`, `formatKcc20BaseUnitsForDisplay`, `calculateKcc20OrderTotalSompi` | [token-amount.ts](../src/token-amount.ts) |
| Fees | `buildCreateOrderFeeQuote`, `buildStandaloneFillFeeQuote` | [trade-fee.ts](../src/trade-fee.ts) |
| Paid mint | `buildKcc20PaidMintAmountQuote` | [paid-mint-amount.ts](../src/paid-mint-amount.ts) |
| Source selection | `normalizeKcc20IndexedUtxos`, `selectOwnerNativeHolderUtxo`, `selectConsolidationBatch` | [action-source-resolver.ts](../src/action-source-resolver.ts) |
| Source validation | `assertSnapshotFresh`, `assertUniqueSources` | [source-validation.ts](../src/source-validation.ts) |
| Ladder orders | `planKcc20LadderLimitOrders` | [ladder-limit-orders.ts](../src/ladder-limit-orders.ts) |
| Artifacts | `KCC20_ARTIFACT_SCRIPT_SHA256`, `assertKcc20ArtifactScriptHash`, `isKcc20ArtifactKey` | [artifacts.ts](../src/artifacts.ts) |
| Errors | `Kcc20BuilderError`, `Kcc20BuilderErrorCode` | [errors.ts](../src/errors.ts) |

The root also exposes ABI, encoding, protocol, and receipt helpers through
[index.ts](../src/index.ts). `saleCommon` is a namespace export. The engine's
`protocol` helpers have a loose index-signature type and should be treated as
low-level APIs requiring operation-specific validation.

## Structured error codes

`Kcc20BuilderErrorCode` currently includes `INVALID_INPUT`, `MISSING_SOURCE`,
`STALE_SOURCE`, `ARTIFACT_MISMATCH`, `UNSUPPORTED_OPERATION`,
`WASM_CAPABILITY_MISSING`, and `SERIALIZATION_FAILED`. These codes apply to
structured errors only. The engine also emits ordinary errors and additional
operation-specific error fields.
