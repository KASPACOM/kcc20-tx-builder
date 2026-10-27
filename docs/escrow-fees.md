# Experimental fee escrow primitives

These exports support the new DEV fee-market contracts. Existing transaction
construction still uses the legacy fee version. These functions do not build,
authorize or submit escrow spends, and this change does not publish a package.

`calculateKcc20EscrowFees` implements the fixed 1% protocol fee and optional
0–5% creator fee. Each nonzero share has a 0.5 KAS minimum, applied per fill.
`protocolWaived` is a quote assumption. A transaction builder must independently
authenticate and consume an eligible FeeTicket before using that assumption.

`quoteKcc20EscrowSettlement` returns the trading-price and fee components for
take-ask, fill-bid and crossed settlements. Ask buyers pay fees above the price;
bid sellers receive price minus fees; a crossed matcher funds the fee once.
The result excludes network fees and storage deposits and is not a complete
wallet debit/proceeds quote. Fills that cannot cover their fees are rejected.

`calculateKcc20FeeClaim` checks the accounting for one through five distinct
receipts from the same token, market, policy and fee accounts. It returns the
claim and retained amounts. This does not establish that the receipts exist,
are unspent or have authenticated scripts. Construction must revalidate all
inputs against current chain state and the approved artifacts.

`encodeKcc20EscrowPolicy` and `decodeKcc20EscrowPolicy` implement the fixed
169-byte orderbook policy. They reject unsupported versions, noncanonical
integers, invalid rates and invalid account identities. `kcc20EscrowPolicyId`
hashes token ID, FeeTicket ID, price scale and the complete policy encoding.
The protocol rate and fee floors are constants of this contract version.

`kcc20FeeClaimCommitment` binds the ordered receipt outpoints, account outpoint,
claiming party, amounts, market identity and payout ScriptPublicKey. Supply the
ScriptPublicKey's two-byte version prefix as well as its script bytes. Receipt
order must match the native covenant family's input order. The consensus proof
harness uses the same fixed commitment vector.

Release requires authenticated artifact resolution, settlement and claim
construction, complete signed-transaction mass checks, application integration,
funded TN10 lifecycle proof and independent review of the final artifacts.
