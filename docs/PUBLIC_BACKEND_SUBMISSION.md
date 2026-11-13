# Authenticated backend submission on DEV TN10

Local builder transactions normally go through your wallet or node. To use
`POST /kcc20/submit`, first request the build with the same wallet's public API
bearer token. An anonymous build or a local build has no submission receipt.

## Authenticate and build

1. Call `POST /auth/api/otp` with `{ "walletAddress": "kaspatest:..." }`.
2. Ask the wallet to sign the exact KaspaCom login message using that nonce,
   current ISO date and a new request ID. Use the message format in the backend
   [authentication implementation](https://github.com/KASPACOM/kcc20-backend/blob/40825907f37dae38ffdee9c204a6881f7a7b1d92/src/modules/backend/auth/utils.ts).
3. Send `walletAddress`, `signature`, `date`, `requestId` and `publicKey` to
   `POST /auth/api/wallet-sign-in`. Keep the returned `accessToken` in memory.
   Never write it into evidence or commit it. Login does not sign a transaction.
4. Call the supported public builder with `Authorization: Bearer <accessToken>`.
   For native transfer, use `POST /kcc20/build/tokens/{covenantId}/transfer` with
   `walletAddress`, `recipientOwner` and display-unit `tokenAmount`.

The build response's `requestId` is the submission `buildId`. Its
`payload.signing.networkFee.quote` belongs to this build. Rebuilding with a
fixed relay fee changes the funding change output and fails receipt matching.
Pass the same fresh quote into the local engine's `networkFeeQuote` option when
independently checking a backend build. Pin the backend-selected funding outpoint
as well. If the quote is stale, request a new build; do not forge its observation
time. Check the recipient, token amount, deposits and total wallet debit before
signing. Matching a backend rebuild does not replace that review.

## Sign and submit

Use the existing signing adapter for the operation's declared signing inputs and
covenant script hints. Argument-only witnesses do not require wallet signatures.
Recheck inputs, preserve transaction intent and verify the complete signed mass
and quoted fee. Save the signed transaction and its finalized transaction ID in
a private journal **before** submission.

Submit the signed transaction JSON as a string:

```json
{
  "buildId": "the authenticated build response requestId",
  "signedTransactionJson": "the complete signed transaction JSON"
}
```

Send it to `POST /kcc20/submit` with the same bearer token. The returned `txidHex`
must equal the locally finalized transaction ID. The API's `submitted` status
means broadcast, not canonical acceptance or indexed balances.

Poll `GET /kcc20/submissions/{buildId}` with the bearer token. Independently check
node/REST acceptance and `GET /trading/tx/{txid}/settlement-status`. After an
unknown outcome, inspect the saved ID and receipt status before constructing a
replacement transaction. A consumed receipt returns HTTP 409 on repeated submit;
use the status route instead of repeatedly broadcasting.

## Verified scope

The [funded evidence](evidence/public-authenticated-submit-20261113.json) records
wallet-signature login, authenticated native transfer construction, local rebuild
agreement with its fee quote, local signing, backend broadcast, canonical
acceptance and indexed decoding. Backend-assisted operations beyond that recorded
flow retain their individual verification status. Forced service crashes and
chain reorgs are not established by this test.
