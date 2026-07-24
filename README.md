# Suho — 수호

**A wallet that knows who you're paying.** Suho turns a Dojang-verified EOA on
GIWA Sepolia into a passkey-secured smart account — same address, same up.id
name — and puts verified identity at the center of every transfer: a dojang
seal for verified humans, a warning for unknown addresses, a one-time code for
large transfers to strangers, and code-based recovery when a device is lost.

## Architecture

```
[Browser: Suho app  (app/, Vite+React+viem)]
      │  WebAuthn (Windows Hello) ──> P-256 passkey signatures
      │  REST
      ▼
[Guardian service  (guardian/, Node+TS+viem, single process)]
      │  holds: RELAYER key (gas), SuhoCodeAttester owner key,
      │         demo EOA key (one-time 7702 upgrade only)
      ▼
[GIWA Sepolia]  normal RPC for writes · Flashblocks RPC for reads/receipts
      │
      ├─ OndolAccount (EIP-7702 implementation; WebAuthn verify via P256VERIFY)
      ├─ OndolTransferGuard (Dojang-verified recipients pass; strangers warn/OTP)
      ├─ AriseModule (passkey rotation via purpose-bound one-time codes)
      ├─ SuhoCodeAttester (EAS attestations for OTP/recovery codes)
      └─ real Dojang / EAS / UpnameRegistry contracts (never mocked)
```

Contract addresses, schema UIDs, and explorer links: `docs/deployments.md`
(all four Suho contracts are source-verified on the explorer).

## Custody (Phase O: non-custodial end to end)

**New-user onboarding never moves a key anywhere.** The browser generates a
one-time secp256k1 bootstrap keypair in a function closure, uses it for exactly
two signatures — the EIP-7702 authorization and the EIP-712 digest that binds
the first passkey (`OndolAccountV2.initializeWithSig`, low-s enforced) — and
drops every reference. It is never put in state, storage, logs, or any network
payload; only the *signatures* travel. The guardian relays one type-4
transaction and pays its gas; a request-body assertion rejects anything
key-shaped on every endpoint, structurally. From that moment the passkey is the
only practical authority; verification (`payAndIssueEAS`, self-attested by the
account) and the up.id name claim (`register`, `msg.sender` = the account) are
call payloads the account executes itself, passkey-signed, relayer-carried.

**7702 root-key honesty.** By EIP-7702's design the secp256k1 key remains the
theoretical root authority of the address. Ours is generated in-tab, used once,
and garbage-collected — unrecoverable and un-persisted, by us or anyone. The
practical threat model is therefore the browser session during those
milliseconds of signing; after that, key compromise is impossible because the
key no longer exists. Recovery runs through Arise's purpose-bound single-use
codes while the testnet issuer operates.

**Legacy demo path.** The alice account predates Phase O: the guardian held her
EOA key for the original one-time upgrade (and its final legacy use, the v1→v2
re-delegation). It is labeled as such in the app. Existing-wallet upgrades
(users delegating their own Rabby/MetaMask EOAs) are pending wallet-side 7702
authorization support — stated, not promised.

Similarly, the Suho Card renders its own honesty line: *identity is verified by
Dojang; card fields are self-declared by the verified owner.* The seal attests
the human — the fields are their claims.

## Upgradeable accounts (Phase G) and migration reality

New accounts delegate to `OndolProxy`, a minimal ERC-1967 proxy, instead of
straight to an implementation. The account can then move to a new implementation
via `OndolAccountV3.upgradeTo`, reachable only through a passkey-signed
`execute()` — the passkey is the sole upgrade authority, no admin or guardian.
Installing the implementation is authorized by the account's own key signing
*which* implementation the proxy may install; that signature defeats a mempool
replay of the 7702 authorization (an attacker cannot point the account at a
hostile implementation, nor initialize the real one with their own passkey). V3
also reimburses gas up to a passkey-signed cap (`maxGasPayment`), so a relayer is
made whole without being able to inflate the charge; a zero cap is the sponsored
path onboarding uses.

Migration is binding:

- **Live-key accounts (alice):** delegated straight to V1/V2 with the EOA key
  still held. Can re-delegate to the proxy and become upgradeable.
- **Gasless-onboarded accounts (key destroyed):** the delegation cannot be
  re-signed, so they stay on V2 permanently. They keep working but cannot
  upgrade. The app shows a "cannot upgrade" note; do **not** attempt to
  re-delegate them.
- **From Phase G on:** proxy-fronted at creation, upgradeable by their passkey.

`/status` reports each account's `delegationShape` and an `upgradeable` flag.

## Probe findings (empirical, on live GIWA Sepolia)

- **EIP-7702**: fully supported. Type-4 delegation, execution at the EOA's
  address, and rollback via `address(0)` authorization all verified live.
  Gotcha: a self-submitted type-4 tx must sign the authorization with
  `nonce + 1` (the tx consumes the current nonce first).
- **P256VERIFY (RIP-7212)** at `0x…0100`: live; RIP-7212 spec vector returns 1,
  corrupted vector returns empty. Fork tests need `evm_version = "osaka"`
  (local revm must include the precompile).
- **up.id resolution**: UpnameRegistry proxy
  `0x091D00004f21eb2Fc30964A8a4995692d9b49628` ("Upbit Web3 Names"). Not
  ENS-style: `tokenId = keccak256(bare label)`, forward = `ownerOf(tokenId)`,
  reverse = `getLabel(bytes32(ownedTokenId(addr)))`. Traps: `ownerOf` returns
  `address(0)` for unregistered names (doesn't revert), and
  `hasActiveName(address(0))` returns true — both must be handled explicitly.
- **Flashblocks**: preconfirmed receipts arrive ~200–630 ms before normal-RPC
  inclusion (best observed ~504 ms to preconfirmation vs ~0.7–1.5 s to
  inclusion). The UI shows each transaction's real measured time.
- **WebAuthn / Windows Hello**: platform authenticator issues ES256 (P-256)
  credentials; browser signatures are DER-encoded and high-s in practice —
  the guardian converts to raw low-s (r, s) before submission.
- **Public RPC pathologies** (handled in the guardian): `eth_getLogs` above
  100k blocks may return a *silently empty* result; some load-balanced backends
  answer any log query with empty (cross-check + canary names); oversized
  multicall batches fail wholesale behind `allowFailure`.

## Screens

Upgrade (7702 in place, passkey created) · Send (live up.id resolution, seal /
warning / OTP interstitial, measured confirmation times) · Directory
(event-scanned, verified-active names only, deep-links to Send) · Card
(self-attested identity card on EAS, refUID version chain, QR + read-only
`#/verify/<address>` view) · Arise (code-based passkey recovery, prove-it
panel).

## Running the demo

```bash
# terminal 1 — guardian ("Upbit Verification Service" on the projector)
cd guardian && npm i && npm run dev     # port 8787; codes also land in codes.log

# terminal 2 — app
cd app && npm i && npm run dev          # port 5173
```

Keys live in the repo-root `.env` (see `.env.example`; testnet-only, never
committed). Contracts: `cd contracts && forge test --fork-url
https://sepolia-rpc.giwa.io` (38 fork tests). Stage directions:
`docs/demo-script.md`.

## Docs site

The docs are VitePress, source in `docs/`, built to `site/docs` so the landing
(`site/index.html`) and the docs deploy together from `site/`.

```bash
cd docs && npm i && npm run docs:build   # outputs to ../site/docs
```

The built output in `site/docs` is committed. There is no CI pipeline, GitHub
Pages serves what is committed, and reproducibility lives in the `docs/` source.
Rebuild and re-commit when the docs change.

The docs open directly at the first content page. `/docs/` redirects to
`/docs/overview/what-is-suho.html`, and every "Docs" link points there, so the
docs never read as a second landing.

Cross-origin links are env-configurable, because the app and docs are separate
origins. The app's "Docs" link uses `VITE_DOCS_URL` (default
`http://localhost:8899/docs/overview/what-is-suho.html`). The docs "Launch app"
link uses `SUHO_APP_URL` at build time (default `http://localhost:5173/`). Set
both to the deployed URLs before a production build. Links use `.html` (no
clean-URL rewrite), so any static server works: `npx http-server site -p 8899`.
