# Native consolidation consensus regression

Run `npm run test:consolidation:consensus` from the TX Builder repository with Node and Rust 1.95 installed. `CONSOLIDATION_EVIDENCE` optionally selects the fixture output directory. Cargo uses the checked-in lockfile and the consensus revision pinned by the current token artifact's compiler.

The Node fixture builds actual PSKTs with the packaged WASM and the authenticated bundled artifacts. It uses deterministic public test keys and simulated RPC UTXOs. It signs the returned leader/delegator witness templates and funding input. The Rust runner executes those exact signed scripts against their input UTXOs and covenant context, with the network signature cost of 1,000 grams (100,000 script units), without recompiling or substituting the token contract.

Coverage includes platform batches of 2 through 8 inputs, Argent batches of 2 and 3, the funding input, merged state, output binding and collateral refunds. Deliberately invalid transactions cover the profile limit plus one, token inflation with otherwise valid signatures, modified outputs and an invalid leader signature with a valid sighash selector. Builder tests also reject forged profile hints, altered states and duplicate outpoints.

This is local consensus execution with fixture UTXOs. It does not establish mempool acceptance, network broadcast, indexer settlement or browser-extension approval. Those remain funded DEV acceptance checks.
