# Native fee wrapper V2 activation

V2 fixes the creator-approved fee policy at activation. Later wrapping requires the token holder's normal signature and no creator proof. Setup must insert the backend-provisioned protocol account into the deployment policy. Automatic provisioning is a separate application integration task; customers must not choose that protocol account.

This is a prerelease-only addition. Existing native V1 and Argent artifacts retain their behavior. New-market creation must remain disabled until the final artifacts and the exact package candidate pass the funded TN10 lifecycle gates.

## Setup

Use `wrapperVersion: 2` with the existing native fee-market deploy and bind builder keys. Keep the actual market ID derived from the selected genesis transaction. A changed genesis requires approval for the new market.

For nonzero creator fees, binding requires the existing creator evidence and exact market/policy consent, plus `creatorTokenUtxo` and `creatorHolderExtensionHex`. The selected token holder must be controlled by the signing wallet. Its authenticated token metadata proves the creator identity; the creator and holder may be different wallets. The builder checks the live token script, covenant ID, amount and metadata opening and returns that input unchanged. The token owner signs its continuation, while separate wallet funding pays the root principal and network fee.

At 0% creator fees, no creator token input or signature is needed. Creator account ID remains zero. The protocol account is still required.

## Existing markets

The indexer derives `wrapperTemplate` from its pinned script and the backend returns it in fee-market discovery. For `KCC20WrapperFeeV2`, pass `wrapperVersion: 2` to wrap and unwrap. V2 wrap has no creator-consent witness fields. Missing version defaults to native V1; never relabel an existing V1 market as V2.

Trade, cancel, cross and holder-consolidation builders resolve the exact bound wrapper hash from the order/root/holder state. An optional version hint must agree with that commitment. This retains existing caller shapes while authenticating V2 markets.

The script and policy remain authoritative. A backend label alone cannot make an altered wrapper or UTXO spendable. Claims and account rotation continue to use the fixed account identities in the policy; rotating authority does not change the fee rates.

## Verification scope

Local builder tests cover activation at 0%, 1% and 5%, missing or altered consent and token evidence, V2 wrapping without creator proof, partial/full unwrap, and automatic wrapper detection. They do not establish node acceptance. Exact-candidate funded TN10 deploy, transfer, wrap, trade and snapshot evidence remains a separate gate before stable promotion or market enablement.
