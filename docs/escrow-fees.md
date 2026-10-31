# Experimental fee escrow primitives

These exports support the new DEV fee-market contracts. Existing trading
transactions still use the legacy fee version. New fee-market creation remains
disabled, and this change does not publish a package.

## Fee account setup

`kcc20fee.create-account` builds a version 1 PSKT with one unbound fee-account
genesis output and a separate wallet change output. The caller supplies the
native token ID and account principal in sompi. The connected wallet's Schnorr
public key controls the account. The builder pins the escrow artifact, checks
the key, computes the account covenant ID, and checks the signed transaction's
fee and mass before returning the PSKT. The wallet signs the funding input.

The creation result includes `metadata.accountGenesisHint`. Save it with the
broadcast result and add the accepted transaction ID as `txidHex`. An unspent
P2SH genesis output does not reveal its account state to the indexer.

`kcc20fee.bind-account` accepts that saved `accountGenesisHint`, or an
equivalent active account record, plus the token, account, market and policy
IDs. It fetches the current account UTXO from the node and checks its script,
lineage, outpoint and principal against the pinned artifact. The wallet signs
the account input and a separate funding input. The bound output keeps the
same account ID and exact principal. Binding is a one-time operation; later
authority changes use the contract's rotation path.

These operations prepare wallet-signable transactions. They do not broadcast
or establish funded TN10 execution. Account creation and binding are only the
first setup steps; trading, claims and rotation still need signed builders.

`calculateKcc20EscrowFees` implements the fixed 1% protocol fee and optional
0–5% creator fee. Each nonzero share has a 0.5 KAS minimum, applied per fill.
`protocolWaived` is a quote assumption. A transaction builder must independently
authenticate and consume an eligible FeeTicket before using that assumption.

`quoteKcc20EscrowSettlement` returns the trading-price and fee components for
take-ask, fill-bid and crossed settlements. Ask buyers pay fees above the price;
bid sellers receive price minus fees; a crossed matcher funds the fee once.
The result excludes network fees and storage deposits and is not a complete
wallet debit/proceeds quote. Fills that cannot cover their fees are rejected.

`quoteKcc20EscrowTradeGroup` takes ordered fills from one atomic trade group.
It calculates each fill's fee independently, then returns one fee vector and
one summed receipt value. A ticket waiver applies to every fill in that group;
crossed matches reject a ticket. The function checks the contract's maximum
fill counts, but it does not prove a group fits the signed transaction mass
budget or that all fills share one authenticated market and taker. The builder
must perform those checks before signing. In the current offline proof, a
two-ask buy passes the conservative mass target and a three-ask buy does not.

`calculateKcc20FeeClaim` checks the accounting for one through five distinct
receipts from the same token, market, policy and fee accounts. It returns the
claim and retained amounts. This does not establish that the receipts exist,
are unspent or have authenticated scripts. Construction must revalidate all
inputs against current chain state and the approved artifacts.

`verifyKcc20FeeReceiptForClaim` reconstructs an indexed receipt from the
pinned escrow artifact and compares its exact script, covenant lineage,
outpoint and value with a UTXO supplied from the canonical node. The caller
must authenticate the market policy, obtain a fresh node result and check the
UTXO again immediately before signing. This helper does not build or authorize
a claim.

`verifyKcc20FeeAccountForClaim` makes the equivalent check for the fee account,
including its owner scheme, guard, principal and exact script. Pass the pinned
receipt template to the claim planner and preserve the selected receipts' order
as the transaction's covenant input order. Both helpers trust the caller to
obtain canonical fresh UTXOs; they cannot establish source quality themselves.

`planKcc20FeeClaimTransition` calculates the claimant payout, unchanged
account principal, account continuation and any receipt left for the other
party. Its inputs still require live UTXO checks and account authorization.
The plan does not select funding, sign or estimate transaction mass. It rejects
an account whose program template differs from the verified receipt template.

`encodeKcc20EscrowPolicy` and `decodeKcc20EscrowPolicy` implement the fixed
361-byte role policy, with receipt, root, holder, ask, bid and FeeTicket
template tuples in that order. They reject unsupported versions, noncanonical
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
# Creator consent

`kcc20CreatorFeeConsent` produces the public message and personal-message hash
for the new TN10 wrapper. The authenticated creator signs `message` using the
wallet's standard message-signing API. The commitment covers the native token,
market, FeeTicket, scale and exact immutable fee policy, including account IDs.
The helper only constructs the message; it does not authenticate metadata,
verify a signature, grant creator rights or enable a market.
