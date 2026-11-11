# KaChat compatibility primitives

This integration is not enabled in the platform yet. It implements public KaPost payloads and version-1 self-send construction, not encrypted chat or a new token contract.

`kaChatSigningMessage(action)` returns the exact personal message the wallet signs. `buildKaChatPayload(action, publicKey, signature, runtime)` verifies that signature using the host's Kaspa runtime and encodes the signed `kchat:1:` payload. Supported actions are post, reply, upvote and unvote. The platform composer limits new text to 2,000 UTF-8 bytes. No private key enters this package.

`buildKaChatSelfSend` takes one freshly fetched ordinary wallet UTXO, the configured and independently observed network, the current fee-rate quote, and a maximum fee approved by the host. Supply the existing Kaspa runtime and consensus mass calculator. The output returns all principal minus network fees to the same wallet. The builder budgets a complete P2PK signature before signing, enforces compute/transient/storage limits separately, and returns an unsigned transaction with its fee and mass quote.

Use the returned transaction with the existing PSKT wallet flow. The caller must verify the final signed transaction against the approved unsigned transaction, remeasure it, recheck the input and current wallet/network, persist its ID and signed bytes, and only then broadcast. An ambiguous response must reconcile that exact ID. Do not rebuild and submit another comment automatically.

`kaChatSelfSendRequest` describes the upstream SDK's conventional self-payment plus change request. It is a wire-compatibility helper, not the recommended TN10 construction path: the SDK generator can use legacy input fields and a fee estimate that does not cover version-1 storage mass. Use `buildKaChatSelfSend` for the tested TN10 version-1 path.

`kaChatDiscussionKey` and `kaChatRootText` use network plus canonical token covenant ID. They do not authenticate the token or designate an official discussion by themselves. The backend must resolve canonical identity and maintain the unique root mapping; the market wrapper and optional metadata must not become thread identity.

## Verification

Run `npm run test:kachat` for deterministic wire-format and real WASM signature/transaction tests. The complete `npm test` suite includes these tests.

`scripts/prove-kachat-tn10.mjs --submit` is an explicit funded test tool. Set the wallet-file path, Node WASM path, RPC URL and journal directory using its documented environment names at the top of the script. It checks the node's exact network, uses only ordinary funding, caps fees at 0.05 test KAS per action, and saves signed bytes before sending. Its five actions are root, comment, reply, like and unlike. It never imports user keys into the browser or establishes a platform social wallet.

Pinned protocol reference: KaChat Desktop `90035a816c2abc9462066c99f6df668be555c917`, `engine/kaposts.js`. Upstream compressed public keys retain their parity prefix; x-only wallet keys use the even prefix convention. Validate each browser wallet's personal-message and transaction signing before enabling it. SDK proof is not wallet-extension proof.
