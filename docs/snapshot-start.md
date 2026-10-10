# Signerless snapshot builders

Protocol: `signerless-start-v2`. Contract source and shared transaction vectors come from `KASPACOM/kaspa-covenants` commit `d968dca9d77632fff5f740adb78b2f8e3fde54f2`. The artifacts and builders are unchanged at `acd14ce0862d7dc87f5c15c93de07df844120303`.

- `snapshot-signerless`: state encoding, commitments and pure transition plans.
- `snapshot-signerless-transactions`: genesis, start, claim and recipient-transfer transactions.
- `snapshot-deployment`: deterministic peer-first deployment sequencing and token identity.
- `snapshot-verification`: metadata payload and reconstruction of the complete deployment/start transaction from approved inputs.

`prepareSnapshotDeployment` accepts an immutable definition and independently confirmed genesis identities. It returns the next controller, bootstrap or start plan. It does not fetch chain state, select a wallet, approve a candidate, sign or broadcast. Hosts own canonical acceptance, UTXO selection, persistence, governance and recovery.

Only the funding input may be signed for genesis/start. Start consumes the bootstrap and every controller, produces all reserves and initialized controllers, and leaves no bootstrap successor. Maximums are eight shards and Merkle depth twenty.

Pin raw artifact hashes in the host approval. The package also verifies compiled script hashes. Compiler and standards pins are in `artifacts/snapshot-standards.lock.json`. Preserve legacy records separately; these artifacts cannot silently replace previously approved artifacts.

## Verification

```sh
npm ci
npm test
SNAPSHOT_TEST_WASM=/path/to/kaspa-covenants/wallet-lab/vendor/kaspa-wasm-toc npm run test:snapshot:transactions
npm pack --dry-run
```

The SDK transaction tests use synthetic funded UTXOs. They cover one, two and eight shards, exact reconstruction, metadata, mutated transactions, funding-signature selection, claims and recipient transfers. They do not establish network admission. A funded DEV rehearsal and independent review are required before enabling deployment in a host application.
