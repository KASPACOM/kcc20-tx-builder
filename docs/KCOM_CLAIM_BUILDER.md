# KCOM campaign transaction builder status

The `kcom-claim.fund-vault` operation is TN10-only and uses the campaign artifacts pinned from [contract PR #499](https://github.com/KASPACOM/kaspa-covenants/pull/499). It builds an unsigned PSKT for the vault's `fund` entry. The wallet signs only the native fee input at index 2. The graph-owned KCC20 reserve uses canonical owner-scheme-4 authorization by the vault input.

Funding requires two separate transactions. First, the existing canonical `kcc20.transfer` operation sends the exact campaign budget to the derived campaign graph covenant ID with owner scheme 4. After that accepted token output is live, `kcom-claim.fund-vault` spends it together with the still-unfunded vault output. The builder reconstructs the vault successor and unchanged canonical token reserve, checks both current source outpoints and their covenant IDs, and returns a rebuild-required error for stale sources. It pays the fee from a separate wallet UTXO. A submitted PSKT is not accepted funding until chain and indexer evidence confirm the spend.

The build request uses the existing `kcc20-in-process-pskt-builder-input/v1` envelope with `builderKey: "kcom-claim.fund-vault"`, `network: "testnet-10"`, a TN10 `owner.walletAddress`, and these `params`:

| Field | Meaning |
| --- | --- |
| `graphId` | Derived campaign graph covenant ID, 32-byte hex |
| `vaultState` | Exact current `KCOMVault` state, including frozen terms and `funded: false` |
| `vault` | Current vault `{ transactionId, index }` outpoint |
| `tokenState` | Exact graph-owned canonical KCC20 source state |
| `token` | Current token `{ transactionId, index }` outpoint |

The local pinned-WASM test checks artifact pins, source and successor scripts, token and native output amounts, signing index, engine registration and stale-source rejection. Its vault creation and funded-successor script hashes match the synthetic Argent-engine `tn10-proof-mixed` receipt in [#499](https://github.com/KASPACOM/kaspa-covenants/pull/499). The builder commits compute budgets 60 and 20 for the vault and token inputs, above the local engine's measured 52 and 15; the fee input commits 10. It does not execute the complete PSKT in Argent's engine or submit it to TN10. Backend accepted-deployment verification, token-profile transfer compatibility, full transaction differential execution and funded multi-wallet proof remain required before this path can handle real campaign funds. Other campaign operations are not built yet.
