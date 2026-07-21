# Suho — App Spec (v1): Frontend + Guardian Service

The contracts are live (see deployments/giwa-sepolia.json). This spec covers everything the judges actually see: the Suho web app and the small backend ("Guardian service") that relays transactions and issues Arise codes. Same repo: `app/` (frontend) and `guardian/` (backend).

## 0. PHASE 0 — Probes (report and STOP for OK, same drill as before)

**Probe C — up.id resolution on GIWA Sepolia.** We must resolve `alice.up.id` → 0xacc2… onchain. The registry/resolver addresses are not in the docs we've collected. Discover them empirically: our own wallets executed "Issue UP ID" transactions on the Playground — pull the tx history of 0x23f76916A462adC7583E31e8b4650d51De437eE2 and 0xacc2a6Eb741E147e8D3Ed9213b070656c908Adad from the explorer (API or page scrape) or via cast, find the UP ID issuance tx, and identify the name-service contract(s) it touched. Then determine the read path: standard ENS-style resolver (namehash of alice.up.id) or custom lookup function. Prove it with a cast call resolving alice.up.id to her address, and the reverse (address → name) if supported. Report contract addresses + the working call.

**Probe D — Flashblocks pending semantics.** Against https://sepolia-rpc-flashblocks.giwa.io: send a trivial tx, immediately poll eth_getTransactionReceipt and eth_getBalance with "pending", and measure time-to-preconfirmation vs. time-to-inclusion on the normal RPC. Report the numbers — they go in the pitch.

**Probe E — WebAuthn locally.** A 10-line HTML page confirming navigator.credentials.create/get works with Windows Hello in this environment's browser, producing a P-256 credential. (No chain interaction; just confirms the demo machine can mint passkeys.)

## 1. Architecture

```
[Browser: Suho app]  ── WebAuthn (Windows Hello) ──> passkey signatures
       │  REST
       ▼
[Guardian service (Node/TS, single process)]
       │  holds: RELAYER key (gas), SUHO_CODE_ATTESTER owner key, alice's EOA key (demo-only, for the one-time 7702 upgrade)
       ▼
[GIWA Sepolia]  normal RPC for writes, Flashblocks RPC for reads/receipts
```

Custody note (README + pitch honesty): in the demo the Guardian holds the demo EOA key for the one-time upgrade signature. In production the upgrade authorization is signed client-side by the user's existing wallet; everything after the upgrade is already non-custodial (passkey-signed, guardian is a dumb relayer — the contracts enforce this, and our tests prove a malicious relayer can't tamper, replay, or redirect).

## 2. Guardian service (`guardian/`)

Node 20+, TypeScript, viem, Express (or Hono). Endpoints:
- `POST /upgrade { address }` — demo-only: signs 7702 authorization with the stored EOA key (auth-nonce = tx-nonce + 1 rule!), submits delegation to the OndolAccount implementation, then calls initialize with the passkey pubkey provided in the body. Returns tx hashes.
- `POST /relay { account, calls, webauthnSig }` — encodes execute() and submits with RELAYER key. Returns hash immediately; client watches Flashblocks for the receipt.
- `POST /arise/request { account, newPubKeyHash }` — generates 6-digit code, computes domain per contract spec, calls issueCode() with 10-min expiry. Delivers the code by printing it LARGE in the guardian's console (this terminal window is shown on the projector as "Upbit Verification Service" during the demo — the offchain delivery IS part of the show).
- `POST /arise/complete { account, newX, newY, code }` — submits AriseModule.arise() via relayer.
- `GET /status { address }` — { isVerified (which attester), upId name or null, balance, isOndolAccount (code starts 0xef0100 → our implementation) }.
All keys from .env. CORS open to the app's localhost port. No database — stateless except in-memory code bookkeeping mirror (chain is the source of truth).

## 3. Frontend (`app/`)

Vite + React + TypeScript + viem. No wallet-connect libraries — the passkey IS the wallet. Read the frontend-design guidance if available in the environment before styling.

**Visual direction:** dark charcoal base, warm accent (GIWA's red-orange family), one motif: the roof-tile curve as a recurring divider/mark. Korean-modern fintech, not crypto-cyberpunk. The verified badge is a small dojang-style red seal stamp — that's the one flourish that must land. Desktop-first (demo is a projector), but keep it to a centered ~480px column so it reads like the mobile app it would become.

**Screens (4, no more):**
1. **Upgrade** (first-run): shows the demo EOA (alice.up.id, balance, verified seal) → "Create your Suho passkey" (WebAuthn create, Windows Hello) → "Upgrade wallet" (calls /upgrade) → success state: "Same address. Same name. New powers." with explorer link showing the 0xef0100 code.
2. **Home / Send**: balance (Flashblocks-fresh), recipient field that accepts a name or address — live-resolves up.id (Probe C path) with a 300ms debounce; recipient card shows seal + name if verified, amber "Unverified address — Suho can't identify who this is" if not (mallory's moment). Amount, send → passkey prompt → optimistic pending state → preconfirmed checkmark with the measured ms shown ("confirmed in 214ms") → final.
3. **OTP interstitial** (auto-appears when guard requires it): "This is a large transfer to an unverified address. Enter the verification code sent to you." 6-digit input → retry send with code.
4. **Arise**: deliberately theatrical. "Lost your device?" → creates a NEW passkey (simulating the new phone) → requests code → user reads it off the "Upbit Verification Service" terminal → enters it → arise() → success: "You have risen. Same address, same name, new key." Then prove it: old-passkey send fails, new-passkey send succeeds.

**States that must not be janky:** RPC lag (read-twice pattern from the deploy notes), WebAuthn cancel/timeout, insufficient balance, code expiry countdown on the OTP screens.

## 4. Wire-up order (after Phase 0 OK)
1. Guardian /status + /upgrade against live contracts; upgrade alice for real (this is the moment alice becomes the first Ondol account on GIWA).
2. Frontend screens 1–2 against guardian; real send alice → suho.up.id (verified path).
3. Guard path: send alice → mallory small (warning), then large (OTP interstitial, full round trip).
4. Arise flow end to end with a second passkey.
5. Polish pass: timings shown, seal stamp, empty/error states.

## 5. Demo script (docs/demo-script.md — write it as step 5, it's a deliverable)
The exact click-by-click stage sequence with expected screen states, the two terminal windows to have open (guardian = "Upbit Verification Service"), fallback notes if RPC is slow, and the three explorer tabs to pre-open (alice's code, an attestation, the arise tx).

## 6. Non-goals (binding)
No user accounts/db, no multi-user support, no token lists or swaps, no mobile build, no mainnet config, no session persistence beyond localStorage of the credential id, no analytics. If it's not in this file, it doesn't exist.

## 7. Acceptance
- All three probes reported and OK'd before build.
- Live on-chain demo path works end to end on GIWA Sepolia per §4, driven only through the UI.
- README updated: architecture diagram, custody note, probe findings (7702, P256VERIFY, up.id resolver, Flashblocks timings) — this section doubles as submission material.
- demo-script.md exists and matches reality.
