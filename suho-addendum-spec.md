# Suho — App Spec Addendum (v1): Polish, Directory, Card

Extends docs/suho-app-spec.md. Three phases, strictly in order. Phase P ships before Phase D starts; Phase D before Phase C. Each phase ends with everything still working (the §4 click-script flows must not regress — re-verify Send + OTP + Arise still function after each phase).

## PHASE P — Polish (submission-safety)

P1. **Seal prominence + label.** Enlarge the dojang seal on recipient cards and pair it with an explicit "Verified human" label; unverified stays the amber warning. The seal is the brand — it should be legible from a projector.
P2. **Attestation label wording.** Replace "Identity verified by TESTNET FAUCET" with "Dojang attestation · testnet issuer" (keep the attester detail in a tooltip/small print). Honest, but doesn't read as "fake" to a skimming judge.
P3. **Guardian banner.** Fix the mojibake: plain-ASCII box art, or set console UTF-8 on startup (chcp 65001 / SetConsoleOutputCP). Verify by actually printing a code banner and confirming it renders clean in a fresh PowerShell window.
P4. **Demo amount headroom.** The demo flows must never die on gas math: /status should expose a "demo readiness" check (alice balance sufficient for: one verified send + one OTP send at threshold+0.001 + arise gas, with 30% margin) and the app shows a small warning chip when below. No auto-topups.
P5. **Contract verification on the explorer.** forge verify-contract (Blockscout verifier, https://sepolia-explorer.giwa.io/api) for SuhoCodeAttester, OndolTransferGuard, AriseModule, OndolAccount implementation. Judges clicking tx links must see source, not bytecode. Record verification status in docs/deployments.md.
P6. **Timing display audit.** Every send shows its real measured ms (already specced); confirm the OTP and Arise paths show it too.

## PHASE D — Directory screen

D1. **Data path.** Enumerate registered names from UpnameRegistry (0x091D00004f21eb2Fc30964A8a4995692d9b49628) registration/Transfer events via eth_getLogs (chunked block ranges; the chain is young, full scan is fine) — guardian endpoint GET /directory returns [{name, address, active}]. Gate every entry on hasActiveName(owner) AND owner != address(0) (the known registry traps). Cache in guardian memory with a manual refresh param; no DB.
D2. **UI.** New "Directory" nav item: searchable list, each row = seal + name + truncated address + "Send" button that deep-links into the Send screen with the recipient prefilled. Verified humans only — this list IS the trust surface, no unverified addresses can appear in it by construction.
D3. **Self row.** alice's own entry gets a subtle "you" marker.

## PHASE C — Suho Card (attested identity card)

C1. **Schema.** Register one new EAS schema (SchemaRegistry predeploy, resolver 0, revocable): `string displayName, string contact, string remarks`. Record UID in deployments.
C2. **Issuance path — self-attested via the account.** The card attestation is made BY the Ondol account itself: the app builds an EAS attest() call (recipient = the account, refUID = previous card UID or bytes32(0) for v1) and routes it through execute() with a passkey signature. No guardian-owned keys attest cards — every card version is provably passkey-signed by its owner. The guardian only relays.
C3. **Update = new attestation + revoke old, atomically.** One execute() batch: [attest(new, refUID=old), revoke(old)]. The refUID chain is the version history. Never delete, never mutate.
C4. **Card screen.** Virtual-card rendering: seal, up.id name, displayName, contact, remarks, attestation UID (short), version number (chain depth), and a QR encoding `https://sepolia-explorer.giwa.io/address/<account>` for now (upgrade path: our own /verify route). Edit mode → passkey sign → new version. Show "vN · updated <date>" with a tappable history listing prior versions and their revocation times (walk the refUID chain via eas.getAttestation).
C5. **Verify view.** Read-only route /verify/<address-or-uid>: resolves live — Dojang verified? active up.id? current card fields? version history with timestamps. This is what a QR scan should eventually land on; keep it shareable (no passkey needed to view).
C6. **Honesty line, rendered on the card itself (small print):** "Identity verified by Dojang. Card details are self-declared by the verified owner." The seal attests the human; the fields are their claims. Do not blur this.

## Non-goals (binding)
No X/email verification challenges, no card images/avatars, no third-party card viewing app, no mainnet config, no card sharing besides the QR/link.

## Acceptance
- §4 click-script flows re-verified green after each phase.
- Directory shows only active, verified names; alice's row deep-links to Send.
- Card v1 → edit → v2 works end to end passkey-signed; refUID chain walkable in the UI; old version shows as revoked with timestamp; verify view loads for alice from a clean browser session.
- All four contracts source-verified on the explorer.
- README + demo-script.md updated to include Directory and Card moments.
