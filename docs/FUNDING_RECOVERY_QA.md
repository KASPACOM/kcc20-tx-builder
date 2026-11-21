# Funding classification: PUB-030 / RT2-125, ZPM-007 / RT2-127

The selector previously threw the same text when the wallet had 0.39 KAS and when it had enough KAS split across outputs. Consumers could not prove which recovery applied.

The selector now emits the existing builderErrorCode/builderErrorDetails envelope. INSUFFICIENT_KAS_BALANCE means eligible entries sum to less than requiredFundingSompi. INSUFFICIENT_SINGLE_KAS_UTXO means that sum is sufficient but no single entry fits. Details carry requiredFundingSompi, availableFundingSompi, largestFundingUtxoSompi and shortfallSompi as integer sompi strings. Seller sweep wrappers retain these codes.

- [x] Reproduce missing codes on current main with selector regression before changes.
- [x] 0.39 KAS versus 0.5002 KAS requires 0.1102 KAS more; consolidation cannot supply it.
- [x] Two 0.3 KAS entries versus 0.5002 KAS classify as fragmentation.
- [x] Explicitly excluded/reserved inputs do not contribute to available funding.
- [x] Sufficient input selection is unchanged; existing pinned-funding tests still pass.
- [x] Full npm test passes, including typecheck/build, pinned funding, network fee and transaction construction suites.
- [x] Independent source review completed.
- [ ] Publish a new immutable package version and pin frontend/backend after authorization. No version published by this task.
- [ ] Hosted CI and deployed connected-wallet acceptance.

This changes errors, not transaction construction or input selection. It does not consolidate, retry, alter pricing, or sign. Availability is the input snapshot supplied by the source with explicit exclusions applied; this does not introduce wallet-lock discovery or prove live mempool lock visibility. Pinned-input errors remain pinned-input errors.

Frontend/backend companions normalize the structured error, retain recovery metadata in the browser signing-stage catch, and use neutral guidance for older errors without totals. Existing package versions cannot produce the new distinction until consumers are updated.
