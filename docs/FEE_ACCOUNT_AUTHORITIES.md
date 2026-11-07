# Fee-account claim and rotation signing

The existing escrow artifact supports schemes 0 through 4. This builder change
adds spending for schemes 2 and 3 without changing those artifact bytes. It does
not enable fee-market creation or change existing trading, snapshot or mint flows.

## ECDSA public-key hash (2)

Set the host engine's `walletSigningCapabilities.ecdsa` to `true` only when its
wallet adapter can sign ECDSA inputs. The default remains `false`. Supply the
compressed 33-byte key in `request.owner.publicKey`; it must hash to the account
owner and have the same x coordinate as the connected Schnorr funding wallet.

The account's script hint has `signatureAlgorithm: "ecdsa"`. The adapter must
sign the ECDSA transaction hash, return compact low-S r/s plus `SIGHASH_ALL`, and
prepend the compressed key as instructed by the signature argument. Funding
inputs still use Schnorr. A Schnorr signature cannot satisfy the ECDSA account.
The example signing adapter rejects ECDSA unless explicitly opted in.

## Exact P2SH (3)

The connected Schnorr wallet must match the account's `guard_template` action
key. Supply `params.authority` with `txidHex`, `vout`, `address`,
`redeemScriptHex`, `arguments`, and `computeBudget`. The redeem script must hash
to the account's exact owner program. The builder fetches the outpoint and
checks its live script and address before adding it.

Arguments support bounded `data`, `i64`, and at most one Schnorr `signature`
slot with an optional prefix. They describe the selected P2SH program's witness;
consensus must execute that program successfully. The adapter must review the
program and supply any required preimages. Unsupported witnesses must not be
presented as spendable.

The builder recreates the authority UTXO with its full live value and exact
script. Its principal cannot fund fees. A lineage-bound authority uses the
existing scheme-4 recipient path instead. This path supports ordinary P2SH
programs compatible with an unchanged continuation, not arbitrary covenant state
transitions or general multi-party signing.

The account witness is the one-byte authority input index followed by the action
signature. Merely spending the P2SH input does not authorize the account. The
signature commits to selected receipts, payouts, retained shares and account
continuation. Rotation changes only the selected account authority.

## Claims and proof boundaries

Both paths claim one through five compatible receipts. Each pays the selected
party's entire share and preserves the opposing share in one receipt. Account
principal and P2SH authority principal are preserved; a separate wallet input
funds network fees. Mass checks cover the complete predicted signed transaction.

Offline fixtures sign both schemes, compare Schnorr hashes with the pinned WASM
signer, and export transactions for the pinned Rust consensus runner. The runner
also checks the independent ECDSA hash serialization. Funded TN10 and browser
proof are separate release gates. Frontend PRs remain unmerged.
