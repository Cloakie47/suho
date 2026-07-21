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

## Custody honesty note

In the demo, the Guardian holds the demo EOA's key **only** to sign the
one-time EIP-7702 upgrade authorization. In production that authorization is
signed client-side by the user's existing wallet. Everything after the upgrade
is already non-custodial: every operation is passkey-signed by the user, the
guardian is a dumb relayer, and the contracts enforce it — our fork tests prove
a malicious relayer cannot tamper with, replay, or redirect a signed batch.

Similarly, the Suho Card renders its own honesty line: *identity is verified by
Dojang; card fields are self-declared by the verified owner.* The seal attests
the human — the fields are their claims.

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
