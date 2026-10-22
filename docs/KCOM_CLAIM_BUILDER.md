# KCOM campaign transaction builder status

The TN10-only `kcom-claim.fund-vault` and `kcom-claim.create-shard` operations use the campaign artifacts pinned from [contract PR #499](https://github.com/KASPACOM/kaspa-covenants/pull/499). Each builds an unsigned PSKT. The wallet signs only the native fee input: index 2 for vault funding and index 1 for shard creation. The graph-owned KCC20 reserve uses canonical owner-scheme-4 authorization by the vault input.

Funding requires two separate transactions. First, the existing canonical `kcc20.transfer` operation sends the exact campaign budget to the derived campaign graph covenant ID with owner scheme 4. After that accepted token output is live, `kcom-claim.fund-vault` spends it together with the still-unfunded vault output. The builder reconstructs the vault successor and unchanged canonical token reserve, checks both current source outpoints and their covenant IDs, and returns a rebuild-required error for stale sources. It pays the fee from a separate wallet UTXO. A submitted PSKT is not accepted funding until chain and indexer evidence confirm the spend.

The build request uses the existing `kcc20-in-process-pskt-builder-input/v1` envelope with `builderKey: "kcom-claim.fund-vault"`, `network: "testnet-10"`, a TN10 `owner.walletAddress`, and these `params`:

| Field | Meaning |
| --- | --- |
| `graphId` | Derived campaign graph covenant ID, 32-byte hex |
| `vaultState` | Exact current `KCOMVault` state, including frozen terms and `funded: false` |
| `vault` | Current vault `{ transactionId, index }` outpoint |
| `tokenState` | Exact graph-owned canonical KCC20 source state |
| `token` | Current token `{ transactionId, index }` outpoint |

After the campaign factory is opened, `kcom-claim.create-shard` spends its current factory outpoint and creates one numbered shard. Its request uses the same envelope with `builderKey: "kcom-claim.create-shard"` and `params: { graphId, factoryState, factory }`. `factoryState` is the exact open `KCOMFactory` state; `factory` is its current `{ transactionId, index }` outpoint. The builder derives the next factory state and initial shard state from that source, preserves their combined native KAS, and rejects a stale factory or a completed shard sequence. Each accepted shard creation consumes the previous factory, so the next build needs the new outpoint and incremented state.

The local pinned-WASM test checks artifact pins, source and successor scripts, amounts, signing indexes, engine registration, stale-source rejection and fee-output mutation. Vault funding's source/successor scripts and all four shard-creation successor scripts match the synthetic Argent-engine `tn10-proof-mixed` receipt in [#499](https://github.com/KASPACOM/kaspa-covenants/pull/499). The builder commits budgets 60/20 for vault/token inputs, above measured 52/15, and 30 for shard creation's factory input, above measured 22. Fee inputs commit 10. These PSKTs have not been executed as complete transactions in Argent's engine or submitted to TN10. Backend accepted-deployment verification, token-profile transfer compatibility, complete transaction execution and funded multi-wallet proof remain required before using real campaign funds. Opening, tier selection, close, settlement, activation and recovery builders remain unfinished.
