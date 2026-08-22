# Suho security

Reviewer-facing summary of Suho's threat model, where each control is enforced, and the results of the August adversarial audit (Phase SEC sections A to F plus the Phase M additions). It answers "is it safe from every angle" with a checklist rather than a claim, and it states the limitations honestly.

Scope: Suho on GIWA Sepolia (testnet, chain id 91342). Three parts: a browser app, a guardian relayer service, and contracts on chain. The browser holds the keys, the guardian pays gas and delivers recovery email, the contracts enforce the rules.

## Assets and adversaries

What an attacker wants:
- To move funds from an account they do not control.
- To take over an account (install their own passkey, repoint the guard, install a malicious implementation).
- To learn who a person is (deanonymize an address, harvest a recovery email).
- To drain the relayer.

Adversaries we defend against:
- A hostile relayer (the guardian itself is untrusted with respect to authority: it can censor and it pays gas, but it cannot move funds or forge authority).
- A network attacker who captures signed payloads and replays or tampers with them.
- A passkey-only attacker who has stolen a device passkey but not the recovery email.
- Anyone probing the guardian's public HTTP surface with malformed or hostile input.

Adversaries we do NOT fully defend against (see Limitations): an attacker who holds BOTH the passkey and the recovery email; a compromise of the guardian process plus its email inbox.

## Where each control is enforced

| Control | Contract | Guardian | Client |
|---|---|---|---|
| Transaction authority (only the account's passkey moves funds) | Yes: `OndolAccount` verifies the WebAuthn P-256 signature on chain via the RIP-7212 precompile before running any call | No: the relayer only encodes `execute()` and pays gas | Signs the execute challenge `keccak(account, chainId, nonce, calls, maxGasPayment)` in a passkey prompt |
| Signature binds exact (recipient, value, cap, nonce, chain) | Yes: the challenge covers the calls and cap | No | Computes the identical challenge |
| Gas reimbursement cap | Yes: `OndolAccountV3` pays at most the signed `maxGasPayment` | Recommends a fee; cannot exceed the signed cap | Shows and signs the cap |
| Transfer guard (verified pass, stranger warn, large-stranger loud event) | Yes: `OndolTransferGuard` | No | Renders the warning and the hold-to-confirm |
| Recovery (passkey rotation) | Yes: `AriseModule` rotates only after a single-use, domain-bound code is consumed via `SuhoCodeAttester` | Mints the code and emails it OUT OF BAND to the bound address only | Drives the flow; never sees the code |
| Recovery email binding | No | Passkey-gated: only the account controller can set the recovery email; stored AES-256-GCM encrypted, looked up by keyed hash | Signs the gate challenge |
| Onboarding (gasless) | Proxy + V3 init verify the EIP-712 init signature (chainId + verifyingContract bound) | Pays gas; per-IP and daily caps; one onboarding per passkey | Generates a one-time EOA key in a closure, signs twice, discards it |
| Key-material firewall | No | Rejects any request body carrying a private-key-shaped field before any handler | Never sends key material |
| Memos (public notes) | Yes: `SuhoMemo.note()` emits `Memo(from,to,text)`, caps 140, holds no state | No (memos are on chain, not stored) | Batches the note into the same `execute()`; attributes memos by the indexed `from` |
| Return requests | No (guardian-stored) | Verifies on chain the anchor tx is a real transfer from the verified requester to the receiver in an allowlisted token; mark-returned only accepts an on-chain-verified return | Content-bound passkey proof to create; lazy session for receiver actions |
| Data at rest | No | Recovery emails and return-request bodies are AES-256-GCM ciphertext; distinct HKDF subkeys | No secrets in localStorage (addresses, credential ids, flags only) |

The load-bearing property: authority lives in the account contract and the passkey, never in the guardian. A malicious or compromised relayer can refuse to serve or waste its own gas, but it cannot move funds, forge a signature, or repoint an account.

## Audit results (August)

Legend: PASS verified; FIXED failed then fixed and re-verified; CONFIG code is correct, the deployed value must be confirmed on the Railway/Cloudflare dashboards.

### A. Recovery code binding
- A1 cross-account code rejection: PASS (fork tests)
- A2 wrong-target rejection: PASS (code bound to `keccak(account,newKey)`)
- A3 replay and re-issue invalidation: PASS
- A4 expiry: PASS
- A5 enumeration resistance: PASS (byte-identical `/arise/request` response for enabled, no-recovery, non-account)

### B. Gas reimbursement
- B1 cap enforcement (100x hostile relayer pays exactly the cap): PASS
- B2 signed-cap integrity (higher claim reverts): PASS
- B3 insufficient balance reverts before executing: PASS
- B4 onboarding caps + duplicate-passkey rejection: PASS
- B5 relayer floor pauses sponsored onboarding, keeps reimbursed ops, never silent: PASS

### C. Passkey and account control
- C1 wrong-credential signing reverts: PASS
- C2 post-Arise old key is dead: PASS
- C3 upgrade authority is self-only: PASS
- C4 init front-run / cross-account replay reverts: PASS

### D. Guardian untrusted-input surface
- D1 key-material rejection (privateKey / mnemonic bodies -> 400): PASS
- D2 CORS locked to the app origin: CONFIG (code uses `SUHO_CORS_ORIGINS`; if unset it defaults to `*`. Production must set it to the app origin.)
- D3 input validation: FIXED (`/status` on a malformed address returned 500 with a raw error; now a clean 400)
- D4 email injection (header / HTML): PASS (`EMAIL_RE` rejects whitespace; the address is never rendered as unescaped HTML)
- D5 ops endpoint auth (401 without or with a wrong token; never returns a code or key): PASS
- D6 rate limits hold; cooldowns do not leak account existence: PASS

### E. Secret and data hygiene
- E1 repo and full git-history scan for keys/tokens: PASS (`.env` files gitignored, zero commits touch them, no secret-value patterns in history)
- E2 log scan: PASS (no code, email, or key is logged; a stale pre-OTP `codes.log` was removed, it was gitignored and never committed)
- E3 encryption at rest: PASS (emails and message bodies are `iv.tag.ciphertext`, no plaintext in Postgres)
- E4 response leakage: PASS (human sentences plus a details disclosure; no secret or raw trace reaches the client)

### F. Client and deploy
- F1 bootstrap EOA key never enters state/storage/network/logs; generated in a closure, used, discarded: PASS
- F2 no secrets in localStorage (addresses, credential ids, boolean flags only): PASS
- F3 HTTPS only in production, `VITE_GUARDIAN_URL` is https, no mixed content: CONFIG
- F4 deployed env parity, `SUHO_EMAIL_ENC_KEY` identical so stored data stays decryptable: CONFIG

### Phase M additions
- Return-request binding: PASS (verified sender, real anchored transfer requester -> receiver, allowlisted token; forged hashes, direction spoofs, and non-transfer txs rejected; mark-returned is on-chain-verified for direction, token, and amount within a token-aware tolerance)
- Messages endpoints: PASS by design (inbox/sent are public by the current "public for now" stance and leak nothing beyond the two parties' message content and on-chain facts; receiver actions 401 before any DB lookup; block is silent; 3 requests/day; bodies sanitized and encrypted at rest)
- SuhoMemo: PASS (`note()` is a public emitter by design; the app attributes memos only by the indexed `from`, so a third party cannot make a memo appear to come from someone else; the 140-char cap is enforced app-side and on chain; text renders escaped)
- /recovery enumeration: FIXED (see below)

### Production parity
- SUHO_DEV absent so `/upgrade` and `/demo-credential` return 404 and no demo key loads: PASS (verified)
- Production bundle contains zero demo/upgrade strings: PASS (verified on the built bundle)
- CORS locked, `DATABASE_PUBLIC_URL` absent on Railway, relayer floor configured, Cloudflare rpId and URLs correct: CONFIG (operator confirms on the dashboards)

## The /recovery resolution

Before the audit, `GET /recovery?account=` returned `{ enabled, maskedEmail }` to any caller. That let a stranger learn whether an account had recovery and the masked form of its recovery email (first character plus domain), which is an enumeration and targeting leak against a specific person.

Resolution (shipped): `/recovery` now returns only `{ enabled }`. The masked email is not served on any public endpoint. Recovery delivery goes to the address on file without ever echoing it back; the Arise and checklist screens say "the recovery email on file" instead of showing the address. Recovery status (`enabled`) remains readable because the account owner needs it for their own setup checklist and it is low sensitivity relative to the address itself.

## The bank model: spending limits

The transfer policy is now deterministic and owner-set, not recipient-based. This replaces the earlier "verified recipients pass, large unverified sends warn" model, which was a gameable heuristic on a testnet where the seal is self-serve (see the expired-attestation lesson below). The active policy is `OndolSpendingGuard` (`contracts/deployments/giwa-sepolia.json: ondolSpendingGuard`).

How it works. Each account has a per-transaction maximum and a rolling daily total, stored in the guard per account, with sensible defaults on onboarding (0.01 ETH per send, 0.02 ETH per day) and fully owner-configurable. A send within both limits needs only the passkey — one tap, to any recipient, verified or not. A send over either limit needs a second factor: a six-digit code the guardian emails only to the account's confirmed recovery address, consumed on chain by the guard, plus a client hold-to-confirm. Raising a limit, or disabling it (setting it to no cap), is likewise gated by the emailed code; lowering a limit is passkey-only. The daily window is a fixed 24 hours anchored on the first spend after a reset.

One prompt, honestly counted. An over-limit send costs exactly one passkey assertion: the signature over the execute (bound to recipient and value), which is also the possession factor. Requesting the emailed code is deliberately NOT passkey-gated. A second assertion of the same key — one to request the email, one to sign the send — would be the same authority proving the same thing twice; it would look like an extra factor while adding none. The independent factor is the email the requester cannot read, not a repeat of the key they already hold. Abuse of the email itself (a stranger triggering code mail to an owner) is bounded by a per-account throttle on the guardian, not by a passkey — an availability nuisance at most, never a path to funds, since the code is useless without the send signature.

What it guarantees (with a confirmed recovery email and the account's sensitive-op lock on, both auto-configured at onboarding): a passkey-only attacker who steals a device can move at most the remaining daily headroom the owner chose, in per-transaction-sized pieces, and cannot raise the limits, disable them, repoint the guard, or upgrade the account — every one of those needs the emailed code. Splitting a theft across many payments is bounded by the daily total (the crossing payment reverts). Paying an address the owner used before confers nothing: the guard keeps no per-recipient state, so there is no "familiarity" or allowlist bypass to exploit. Losses are bounded by the owner's own numbers, not by a heuristic about who is being paid.

What nothing here can guarantee. A willing, in-limit payment to a scammer is a valid signature by design — limits do not second-guess a payment the owner makes on purpose. If the recovery email is compromised together with the device passkey, the second factor is gone (inherent to any 2-of-2 where one factor is email). And identity is information, not a control: on testnet the Dojang seal is self-issued, so it shows who an address claims to be, never whether a payment is safe.

Coverage boundary (native ETH and standard token ops). Limits are denominated in native ETH and enforced on the call value. Standard token movement and authorization selectors — `transfer`, `transferFrom`, `approve`, `setApprovalForAll` — cannot be priced in ETH, so any of them always requires the emailed code, bound to the exact (token, calldata); nothing token-side is silently unbounded. A call carrying no ETH value and none of those selectors (an arbitrary contract interaction) passes without a limit check — the guard bounds ETH and standard token movements, but a bespoke drain function on an exotic contract is out of its scope. Decoding and danger-annotating arbitrary calldata is the job of a later transaction-description layer, not this guard; this boundary is stated so it is not mistaken for a guarantee.

The expired-attestation lesson. During this work the testnet Dojang attestation for the reference "verified" wallet lapsed, and every recipient-verification test began failing because the wallet no longer resolved as verified on chain. This is exactly why identity was demoted to information: a testnet attestation is self-serve and impermanent, so gating money on it was never sound. The bank model depends on none of it.

## Honest limitations

- Testnet issuer. Verification is a testnet Dojang faucet attester, not a production KYC issuer. It is display-only identity and gates nothing (see the bank model above). Attestations are also impermanent on testnet — they can lapse.
- Shared email sender. Recovery email is sent from a shared sender until a dedicated domain is configured. Deliverability and spoof-resistance are limited accordingly.
- Pinned pre-G accounts. Accounts delegated straight to V2 (including some gasless-onboarded accounts whose bootstrap key was destroyed) cannot upgrade. They keep working but are pinned to V2.
- Over-limit sends now DO have an independent second factor: the email-delivered code the bank-model guard consumes (see "The bank model" above). It survives a stolen passkey, so an over-limit send is genuinely two-factor. Sends within the owner's limits remain single-factor by design (that is the point of a limit). This supersedes the earlier note that no independent second factor existed.
- The guardian mints all codes and holds the recovery inbox. Suho survives a stolen passkey (recovery is out of band) and survives a compromised guardian with respect to authority (it cannot move funds). It does NOT survive an attacker who holds BOTH the passkey and the recovery email, nor a compromise of the guardian process together with its email inbox. This is inherent to a 2-of-2 where one factor is email.
- Return requests are public by address for now. Anyone can read an account's incoming return-request messages by address. This is a deliberate current-phase choice; a private channel is future work.

## Reproducing the audit

- Contracts: `cd contracts && forge test --fork-url https://sepolia-rpc.giwa.io -j 1` (53 tests). These cover sections A, B, and C.
- Guardian surface (A5, D1, D3, D5, messages, /recovery): live HTTP probes against a running guardian, documented in the audit run.
- Data at rest (E3): direct inspection of the Postgres `accounts` and `tx_messages` tables shows ciphertext only.
