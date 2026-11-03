# Fee recipient wallet adapter

The shared builder can create the pinned `KCC20FeeRecipientV1` example and use it as a fee account's scheme-4 authority. This is an authorization adapter, not holder-reward distribution.

1. Build `kcc20fee.create-recipient` with the token, market and policy IDs and a separately funded principal. Sign and broadcast through the normal wallet flow. Save `metadata.recipientGenesisHint` and attach the accepted transaction ID. The output's lineage is the recipient ID.
2. Rotate the selected fee account to scheme 4 using that recipient ID and the exact recipient template hash and spans. Rotation transfers control of all remaining entitlements for that account. It does not change the other party's account.
3. Build `kcc20fee.claim` with the ordinary account and receipt hints plus `params.recipient`. The builder verifies fresh node UTXOs, the pinned scripts, identity and wallet authority. The recipient wallet signs the joint claim. Account and recipient principals continue unchanged; funding pays network fees separately.
4. Preserve `metadata.recipientContinuation`, attaching the accepted transaction ID, for the next claim. After indexer support is deployed, the same state is discoverable through the active UTXO interface.
5. `kcc20fee.rotate-account` also accepts `params.recipient` when the current account is scheme 4. This allows the recipient wallet to rotate the account back to wallet control. The recipient UTXO continues with the approval commitment.

The minimal example requires a Schnorr wallet. It binds its approval to the account outpoint, action, claim commitment and account continuation. The claim commitment covers selected receipts, the claiming party and payout. A future recipient contract needs its own reviewed adapter; merely supplying an arbitrary covenant input is not supported.

The offline matrix signs one through five receipts for both parties, with and without retained opposing fees, and a rotation back to wallet control. It checks separate mass dimensions and emits transactions for the pinned Rust consensus harness. This is not funded-chain evidence. New market creation and frontend enablement remain separate gates.
