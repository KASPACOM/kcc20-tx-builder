# Argent fee wrap regression

Builder CI 41546707711 and DEV TN10 rejected the V1 wrapper's signed wrap. The normalized token adapter omits Argent's generated marker; V1 had been compiled with that adapter span although its contract reads all seven runtime fields.

The builder now uses `KCC20WrapperFeeArgentV2` from kaspa-covenants PR #747. V2 uses the compiler span, offset 1 and length 145, instead of adapter offset 34 and length 112. Old artifacts and their integrity pins remain packaged. New Argent setup rejects the old wrapper. Native and snapshot artifacts are unchanged.

The consensus workflow executes signed partial/final wraps, unwraps, buys, multi-ask buys, both seller sweeps and crosses using the exact packaged artifact. A Node construction test alone is not consensus proof. The original failed run remains the regression evidence; final V2 consensus and funded lifecycle are pending.
