# Bundled WASM runtime

`kaspa/` contains the unmodified `kaspa-wasm` 1.1.1-toc.1 JavaScript, declarations,
and WASM bundle from `KASPACOM/kaspa-covenants` commit
`acd14ce0862d7dc87f5c15c93de07df844120303`, path
`wallet-lab/vendor/kaspa-wasm-toc`. Copyright Kaspa developers; ISC license
retained in `kaspa/LICENSE`.

Upstream project: https://github.com/kaspanet/rusty-kaspa.
The exact upstream source/build commit is not recorded in the supplied bundle.
See `docs/COMPATIBILITY.json` for file hashes; these pin the tested distribution,
not a claim that an upstream release builds the identical binary.

The TX Builder and example application code use the package's Apache-2.0 license.
Vendored runtime code retains its own license.
