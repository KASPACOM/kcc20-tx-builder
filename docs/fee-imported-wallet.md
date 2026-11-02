# Imported fee-market wallet transactions

The shared builder supports the pinned Argent reference token at zero creator fees. It identifies the token profile from its authenticated artifact and source script. Wrap and unwrap use the matching versioned wrapper witness, including the generated Argent template marker.

Existing holder, ask, bid and root inputs commit an exact wrapper script hash. Trading and consolidation resolve that hash against the pinned native and Argent wrappers for the same token, market and policy. Each operation still verifies the complete input script, lineage and principal against the live node before signing. A request profile label cannot substitute another wrapper.

The token profile has no authenticated creator-consent interface. Nonzero creator fees remain rejected. Existing artifacts, fee arithmetic and native/snapshot flows are unchanged.

Signed offline fixtures cover partial/final wrap and unwrap, ask/bid creation and cancellation, partial/final buys, two-ask groups, 3/10-bid sweeps and crosses. The pinned consensus harness executes the exact generated transactions. Funded TN10 import, decoding and backend lifecycle checks are separate release gates.
