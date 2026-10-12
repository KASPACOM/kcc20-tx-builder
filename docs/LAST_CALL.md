# KCC20 Last Call builders

Target revision: `3fbec524abfbc20e87652eb938db218f8c17db17`.
Local package: `0.5.0-lastcall.0`. This is an unpublished candidate.

## Profile boundary

Authenticate the registry digest, then match an approved profile to a revealed
program and current RPC output. `authenticateTokenArtifact` checks the entire
artifact, ABI, state layout and executable template commitment. Names and
uploaded JSON are not authority.

`buildProfileTransferTransaction` constructs explicit owner or borrowed-receive
transactions. It supports Schnorr P2PK, Schnorr/ECDSA P2PKH, supplied P2SH
authorities and covenant-ID authorities. Callers must obtain fresh authenticated
RPC entries before building and recheck acceptance before signing. Authority
inputs require a reviewed witness adapter. Outputs preserve authority value,
script and identity. Pass the trusted registry manifest, its expected digest and
the selected profile ID; a standalone profile object is not authorization. This
API does not broadcast.

`planTokenOwnerWitness` checks wallet capabilities before signing. Borrowing is
never selected automatically. The normal wallet engine supports its reviewed
public-key paths; advanced authority/borrow callers use the explicit API.

Wrapper construction resolves the approved token template and its committed
wrapper artifact. External custom mint/burn operations are rejected. A profile
must be reviewed before construction; trading qualification remains separate.
Profiles with `displayDecimals` pin the wrapper price scale to that precision.

## Artifact synchronization

From the builder repository:

```sh
node scripts/sync-reviewed-artifacts.mjs /path/to/kaspa-covenants
npm test
npm run verify:compatibility
SNAPSHOT_TEST_WASM=/path/to/kaspa-covenants/wallet-lab/vendor/kaspa-wasm-toc \
  npm run test:snapshot:transactions
npm pack
```

Both backend and frontend must consume the same archive hash. Snapshot pins
include the corrected token, bootstrap and controller artifacts. Earlier source
snapshots are reusable, but previous contract approvals cannot be rebound.

Local tests cover independent bytecode/state offset, profile bounds, owner and
borrow witness construction, malformed commitments, and one/two/eight-shard
snapshot construction. Synthetic funding in these tests is not a funded TN10
proof. Native and independent registry profiles remain candidates until review.
