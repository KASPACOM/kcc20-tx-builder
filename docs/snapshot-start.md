# Signerless snapshot builders

Protocol: `signerless-start-v2`. The exact contract source, constructor arguments,
compiler provenance, and artifact hashes are recorded in `COMPATIBILITY.json`.
During an uncommitted cross-repository review that file is deliberately marked
`uncommitted local review`; rerun the reviewed artifact sync after the contracts
commit exists before publishing the package.

- `snapshot-signerless`: state encoding, commitments and pure transition plans.
- `snapshot-signerless-transactions`: genesis, start, claim and recipient-transfer transactions.
- `snapshot-deployment`: deterministic peer-first deployment sequencing and token identity.
- `snapshot-verification`: metadata payload and reconstruction of the complete deployment/start transaction from approved inputs.

`prepareSnapshotDeployment` accepts an immutable definition and independently confirmed genesis identities. It returns the next controller, bootstrap or start plan. It does not fetch chain state, select a wallet, approve a candidate, sign or broadcast. Hosts own canonical acceptance, UTXO selection, persistence, governance and recovery.

Only the funding input may be signed for genesis/start. Start consumes the bootstrap and every controller, produces all reserves and initialized controllers, and leaves no bootstrap successor. The authenticated bootstrap validates every reserve's complete state and KCC20 template. Each controller independently validates its bootstrap identity, reserve value and token covenant ID, and successor, without duplicating the full KCC20 template in every controller witness. Maximums are eight shards and Merkle depth twenty.

Controller, reserve, and bootstrap deployment cells use 2 KAS. Recipient cells
retain the 0.5 KAS minimum. These values keep an eight-shard start below the
post-Toccata storage-mass limit; lowering them is a protocol change, not a fee
optimization.

`buildSignerlessStart` predicts the signed transaction's compute, storage, and
transient mass before returning it. The unsigned funding input is conservatively
charged for its future P2PK signature. A prepare request fails with
`SNAPSHOT_START_MASS_EXCEEDED` when any predicted dimension exceeds the pinned
TN10 limits (500,000 compute, 500,000 storage, 1,000,000 transient), before the
wallet is asked to sign or broadcast an inadmissible transaction.

Pin raw artifact hashes in the host approval. The package also verifies compiled script hashes. Compiler and standards pins are in `artifacts/snapshot-standards.lock.json`. Preserve legacy records separately; these artifacts cannot silently replace previously approved artifacts.

## Verification

```sh
npm ci
npm test
SNAPSHOT_TEST_WASM=/path/to/kaspa-covenants/wallet-lab/vendor/kaspa-wasm-toc npm run test:snapshot:transactions
npm pack --dry-run
```

The SDK transaction tests use synthetic funded UTXOs. They cover one, two and
eight shards, the exact five-shard Nacho wide-supply fixture, all three predicted
mass limits, exact reconstruction, metadata, mutated transactions,
funding-signature selection, claims and recipient transfers. They do not
establish network admission. A funded DEV rehearsal and independent review are
required before enabling deployment in a host application.

For the bundled offline test runtime, set `SNAPSHOT_TEST_WASM="$PWD/examples/vendor/kaspa"`. CI runs the transaction and claim tests with these pinned bytes. The public-release compiler gate currently reproduces the five core families; source reproduction of the two snapshot artifacts remains a separate release check.
