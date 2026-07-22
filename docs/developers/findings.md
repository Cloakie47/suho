# The findings

Building Suho on a young chain surfaced real behavior that the code now handles. These are the ones worth writing down.

## RPC pathologies

The public RPC is load balanced. Several behaviors follow from that.

- **Stale reads.** Right after a transaction, a lagging node can serve stale state, including empty code for an account that was just delegated. The fix is to read twice and trust a repeated answer, not the first one.
- **Silent empty logs.** `eth_getLogs` over a range wider than 100k blocks can return an empty array with no error. Ranges are chunked to stay under the cap.
- **Lying backend nodes.** At least one backend answers any log query with empty. Empty results are cross-checked against the Flashblocks pool, and a canary of known names refuses to serve an incomplete trust surface.
- **Oversized multicall.** A large `aggregate3` call is rejected wholesale, and `allowFailure` hides it. Batches are kept small so failures surface.
- **Rate limits.** Aggressive parallelism trips the endpoint. The fork test suite runs serially for this reason.

## Registry traps

The UpnameRegistry does not behave like ENS.

- `ownerOf` returns the zero address for unregistered names instead of reverting.
- `hasActiveName(address(0))` returns true.

Both are handled explicitly. The zero address is rejected before the active-name gate, so an unregistered name never resolves.

## High-s signatures

Real Windows Hello signatures are high-s in practice. The on-chain verifier only accepts low-s, matching the daimo malleability rule. The client normalizes each signature to low-s before submission. Without this, the classic "works in the browser, reverts on chain" bug appears. The account's `initializeWithSig` enforces low-s on the secp256k1 side too.

## The osaka precompile

Fork tests run precompiles in the local EVM. The default hardfork has no P256VERIFY, but the live chain does. Fork tests set `evm_version = "osaka"`, which required a newer compiler binary. All pragmas stay at `^0.8.28`.

## The HMR ghost

A long-running dev server can throw a `ReferenceError` for a constant that source no longer references. The dev bundler does not type-check, so a stale hot-reload chain can keep a phantom reference alive. Restarting the dev server clears it. Worth knowing before chasing a bug that is not in the code.
