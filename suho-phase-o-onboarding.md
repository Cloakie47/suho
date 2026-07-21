# Suho — Phase O: Production Onboarding (non-custodial, gasless)

Goal: a stranger with nothing — no wallet, no ETH, no crypto knowledge — opens Suho and ends with a passkey-controlled, Dojang-verified, named account. No private key ever leaves their browser. The guardian relays and pays gas; it never sees key material. The alice demo shortcut becomes a legacy path, clearly labeled.

## O1. Contract: OndolAccountV2 — initializeWithSig

Replace the self-call-gated initialize with signature-gated initialization:
- `initializeWithSig(bytes32 x, bytes32 y, address guard_, address arise_, uint8 v, bytes32 r, bytes32 s)`
- Digest: EIP-712 over domain {name:"Suho Ondol", version:"2", chainId, verifyingContract: address(this)} and struct Init{x,y,guard,arise}. Verify `ecrecover(digest, v, r, s) == address(this)` — only the EOA's own key can authorize its first passkey. Reverts if already initialized.
- Storage layout: identical ERC-7201 namespace as v1 (alice's existing state must remain valid after re-delegation).
- Everything else (execute, rotatePasskey, guard hook) unchanged.
- Fork tests: happy path via relayer submission (no EOA gas); front-run attempt (attacker submits initializeWithSig with their own passkey but no valid EOA sig) reverts; replay of a valid sig on a different account address reverts (digest binds verifyingContract); double-init reverts; alice-migration test — an account with v1-initialized storage re-delegated to v2 keeps working (execute + arise) without re-initialization.

## O2. Deploy + migrate
Deploy OndolAccountV2, record in deployments + docs. Re-delegate alice to v2 (guardian holds her key — legacy path, one last use), verify her flows live (send + status). New onboarding always delegates to v2. v1 impl stays deployed and documented as superseded.

## O3. Guardian: POST /onboard
Body: { address, authorization (signed 7702 auth for v2 impl, nonce 0), initSig {v,r,s}, passkey {x,y} }.
- Relayer submits ONE type-4 tx: authorizationList=[authorization], to=address, data=initializeWithSig(...). Relayer pays gas.
- Guardian validates before spending gas: address has no code, auth targets our v2 impl, chainId correct. Light rate limit (per-IP, N/hour) — testnet gas is real enough to protect.
- Guardian never receives a private key on any endpoint; assert and document.

## O4. Guardian: in-app verification + name claim (kills the Playground dependency)
Excavate the exact registrar calls from our own Playground txs (we have Issue Dojang + Issue UP ID samples for two wallets): the faucet-attester call and UpnameRegistry.register(label). New endpoints or a combined one:
- POST /verify-me { account } → builds the Dojang faucet-issuance call(s)
- POST /claim-name { account, label } → availability check (isClaimable) then register call
Both return CALL PAYLOADS the app routes through the account's own execute() with a passkey signature — the ACCOUNT performs them (msg.sender correctness for the registry), the relayer just carries. If the faucet attester turns out to be issuer-restricted (only its own EOA can attest), report findings and fall back to guardian-triggered issuance for that step only — verification is a third-party attestation by nature, so this fallback is honest; name claim MUST come from the account itself.

## O5. App: onboarding flow (new first screen)
Entry: "Create your Suho account" (primary) / "I have the demo account" (legacy, small).
1. Passkey create (Hello prompt) — "This is your key. No seed phrase exists."
2. In-memory EOA: generate keypair (viem generatePrivateKey) in a closure — never in state, storage, or network. Sign the 7702 authorization (nonce 0) + the EIP-712 init digest. Null the reference immediately after signing. Comment the code loudly: this key is a one-time bootstrap.
3. POST /onboard → pending → success: address revealed, seal-less state ("Not yet verified"), balance 0.
4. Guided setup checklist on Home (replaces empty states until done): ① Fund — address + QR + faucet links ② Get verified — /verify-me via execute ③ Claim your name — label input, availability check, /claim-name ④ Send your first guarded transfer. Each step flips to a seal-stamped done state; checklist disappears when complete.
5. Recovery honesty: after onboarding, one dismissible card: "Lost devices are recoverable via Arise while the testnet issuer operates. Your passkey is the only key."

## O6. Docs: custody section rewrite
README: new-user onboarding is non-custodial end to end (key client-side, one-time, discarded; guardian = relay + gas only). Legacy alice path labeled as the pre-O demo. Add the 7702 root-key note honestly: a discarded bootstrap key is unrecoverable and un-persisted, but 7702's design means the secp256k1 key remains the theoretical root authority — ours is generated, used in-tab, and garbage-collected; threat model documented. Existing-wallet upgrades (Rabby/MetaMask users delegating their own EOAs) are pending wallet-side 7702 authorization support — stated as such, not promised.

## Non-goals
No email/social login, no key backup cloud service, no multi-passkey, no mainnet issuer integration, no fiat onramp. The checklist is not gamification — no points, no confetti.

## Acceptance
- A FRESH browser profile (no prior state) completes: create → fund (faucet) → verify → claim name → guarded send → arise round trip, entirely in-app, user touches only Suho + a faucet.
- Fork tests green including migration + front-run/replay cases; alice works on v2.
- Guardian logs prove no key material ever arrives on any endpoint.
- README custody section rewritten.
