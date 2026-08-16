# Suho: Phase SEC 2.3: OndolAccountV4 sensitive-op lock (spec + test list)

Design only. No contract code until this is approved. This builds the real, honest email second factor deferred from the OTP-guard fix. It closes the gap named in SECURITY.md: today a large unverified send and the account-control ops are gated by the passkey alone, so a passkey-only attacker who steals a device can repoint the guard, install a malicious implementation, or send to a stranger. V4 makes those a 2-of-2 (passkey plus an out-of-band email code) for accounts that opt in.

## Threat it closes

Attacker has the account's device passkey but NOT the recovery email.

Today (V3), with only the passkey the attacker can, inside one passkey-signed `execute()`:
- `setGuard(0)` or `setGuard(permissive)` to remove the transfer policy, then drain.
- `upgradeTo(malicious)` to install an implementation that ignores the passkey and drains.
- Send a large amount to a stranger (only the hold-to-confirm stands in the way, which the attacker just clicks).

V4, when the account opts in, requires an email-delivered code (an independent factor the passkey-only attacker cannot obtain) for each of those. The passkey is still required too, so it is a genuine 2-of-2.

Recovery is deliberately NOT gated: a locked, passkey-compromised account must still be recoverable through Arise (which is already email-gated by its own recovery code). Locking must never brick recovery.

## What stays the same

- V3 semantics for an account that does NOT opt in: byte-identical. The two new storage fields read as `false`/`0` for every existing account, so V4 behaves exactly like V3 until `enableLock()` is called.
- Shared ERC-7201 namespace (`suho.ondol.account`, slot `0x18e1b3…7c00`). V4 appends fields at the end of `AccountStorage`; it does not move or reinterpret any existing slot.
- `rotatePasskey` remains callable only by the AriseModule, unchanged, ungated by the lock.
- The gas-reimbursement path, WebAuthn verification, and `initializeWithSig` are untouched.

## Storage changes

Append two fields to `AccountStorage` (end of struct, same namespace):

```
bool    sensitiveOpLock;     // opt-in: gate control ops behind an email code
uint256 sensitiveOpNonce;    // increments on every consumed sensitive-op code
```

A V3 account upgraded to V4 reads both as zero. No re-initialization. (Solidity packs the new `bool` into the existing final storage word alongside `initialized` if layout allows; the audit must confirm the packed layout does not collide with V1/V2/V3 reads. If packing is uncertain, place `sensitiveOpLock` in its own word to be safe. This is a layout item to verify with `forge inspect storage-layout` before writing code.)

The account references the deployed `SuhoCodeAttester` as a constant `SUHO_CODE_ATTESTER` (like it already references `GAS_ORACLE` and the ERC-1967 slot as constants), so no new init parameter is needed. The account consumes codes itself via `verifyAndConsume`, which is permissionless.

## G1. Control-op lock (setGuard / upgradeTo / disable)

New and changed functions on the account. All control ops are self-call only (reached through a passkey-signed `execute()` targeting the account), so the passkey is always one of the two factors.

- `enableLock()`, self-call. Sets `sensitiveOpLock = true`. Strengthening, so passkey-only (no email code). Requires the account to have a recovery email registered with the guardian is a guardian-side precondition, not enforceable on chain; the app must refuse to enable without one, and the guardian will not mint codes for an account with no recovery email, so a locked account with no email would be un-disable-able except through Arise. Document this sharp edge; the app must gate `enableLock` on recovery-email-present.

- `setGuard(address guard_, string code)`, self-call. If `sensitiveOpLock == false`: behaves like V3 (sets the guard, ignores `code`). If `true`: build domain `suho.op:setguard:<account>:<guard_>:<sensitiveOpNonce>`, call `SUHO_CODE_ATTESTER.verifyAndConsume(address(this), domain, code)` (reverts `CodeNotFound`/`CodeInvalid`/`CodeExpired`/`CodeAlreadyUsed`), then `sensitiveOpNonce++` and set the guard.

- `upgradeTo(address newImpl, string code)`, self-call. Same shape, domain `suho.op:upgrade:<account>:<newImpl>:<sensitiveOpNonce>`.

- `disableLock(string code)`, self-call. Requires a valid email code with domain `suho.op:disablelock:<account>:<sensitiveOpNonce>` whenever the lock is engaged; consumes it; sets `sensitiveOpLock = false`; `sensitiveOpNonce++`. Disabling is the dangerous direction (it removes protection), so it always needs the email code. A passkey-only attacker cannot disable the lock.

The nonce in every domain means a code minted for one op cannot be replayed after any other op has consumed a code (each consume increments the nonce, invalidating every outstanding code). Combined with the attester's single-use guarantee and expiry, replay is closed both within and across ops.

Views: `sensitiveOpLock()` and `sensitiveOpNonce()` so the guardian and app can read state and mint codes for the current nonce.

## G2. Large-send email factor (opt-in transfer path)

When enabled, a large send to an unverified recipient requires a valid email code, bound to the exact recipient and value.

Recommended design (account-enforced, no new guard): reuse the same `sensitiveOpLock` flag OR a second independent flag `emailLargeSendLock` (decision below). When the transfer factor is on, `execute()`'s call loop, for each call, determines whether it is a large unverified transfer by staticcalling the account's guard: `guard.isVerifiedRecipient(recipient)` and `guard.otpThreshold()`. For a native transfer the recipient and value are `call.target` and `call.value`; for an ERC-20 `transfer(to,amount)` the account decodes the 68-byte calldata exactly as the guard does. If unverified and `value >= threshold`, the account requires the `execute()` `otpCode` to be a valid email code with domain `suho.send:<account>:<recipient>:<value>`, consumes it, and only then runs the call. Missing or wrong code reverts before the transfer.

The code is bound to exact recipient and value, so a code minted for one send cannot authorize a different one. It rides in the existing `otpCode` parameter of `execute()`, so no signature-shape change: the passkey still signs the same challenge (the code is not part of the signed challenge, which is correct because the code is the independent factor, not something the passkey should be able to produce).

Scope decision for v1: support the native-ETH large send first; ERC-20 large sends can follow once the in-account decode is audited. Flag this so we do not silently leave ERC-20 large sends unprotected while the flag is on; either support both from day one or have the account revert a large unverified ERC-20 send while the flag is on until it is supported.

## Guardian changes (code minting policy, the load-bearing rule)

- New request endpoints: `POST /op/request-code` (control ops: setguard/upgrade/disablelock, with the target params) and `POST /op/request-send-code` (large send, with recipient+value). Both:
  - Require the account to have a registered recovery email; refuse cleanly otherwise.
  - Are passkey-gated to prevent spam (same gate pattern as `/recovery/request-code`), and rate-limited.
  - Mint the code via `SuhoCodeAttester.issueCode` (owner = the guardian's deployer key) bound to the exact domain (including the current `sensitiveOpNonce` for control ops), with a 10-minute expiry.
  - EMAIL the code to the account's recovery address only. The HTTP response is a generic ack. The code is NEVER in any response body. This is the property that makes it a real second factor: a passkey-only attacker can trigger a request but never receives the code.
- The guardian reads the account's `sensitiveOpNonce()` when minting a control-op code so the domain matches what the account will check.

## Migration (V3 to V4)

1. Deploy `SuhoCodeAttester`-referencing `OndolAccountV4` as a new implementation; source-verify; record in deployments.
2. An account moves to V4 with a normal passkey-signed `execute([upgradeTo(V4, "")])` while unlocked (the `code` is ignored when the lock is off). Proxy-fronted accounts only; pinned V2 accounts cannot upgrade (documented limitation, unchanged).
3. Flags default off, so an upgraded account behaves exactly as before until the owner enables the lock (which the app gates on a registered recovery email).
4. New onboardings can initialize straight to V4 once it is the current impl.

## Client changes

- Account settings: an "Extra protection (email second factor)" toggle, available only when a recovery email is set. Turning it on signs `execute([enableLock()])` (one passkey tap).
- Sensitive ops when locked: the app requests the email code, the user reads it from their inbox and enters it, and the app signs `execute([setGuard(newGuard, code)])` (or upgrade/disableLock). Two factors: the passkey prompt plus the emailed code.
- Large send when the transfer factor is on: on a large unverified send, the app requests a send-code, the user enters it, and it rides in `execute(..., otpCode=code, ...)`. The hold-to-confirm stays as friction; the code is the real factor.
- Honest copy throughout: this protects against a stolen passkey; it does not protect if your email is also compromised.

## G3 (added, load-bearing). Recovery-email-change gate

Attack it closes: a passkey-only attacker changes the recovery email (today a passkey-gated guardian op) to their own inbox, requests an Arise code to that inbox, and rotates the account, defeating the lock through the side door. When `sensitiveOpLock` is on, changing the recovery email must require a code delivered to the OLD address, not just the passkey.

This is guardian-side policy (the email binding lives in the guardian, not on chain). The contract's job is only to expose `sensitiveOpLock()`, which it does. The guardian reads that flag on `/recovery/request-code`: when the account is locked and a recovery email already exists, it will not rebind to a new address on passkey authority alone. It first sends a confirmation code to the CURRENT address; only after that old-address code is confirmed does the new binding proceed. A passkey-only attacker who cannot read the old inbox cannot rotate the recovery channel. Implemented and tested in the guardian phase (with its own adversarial test: passkey-only attacker cannot change the recovery email on a locked account).

## Decisions (resolved, built into the contract)

1. Two independent flags: `sensitiveOpLock` (control ops) and `emailLargeSendLock` (large sends). Built.
2. G2 is ETH-only; a large unverified ERC-20 send reverts `LargeSendErc20NotSupported` while the send lock is on, until the token decode is audited. Built.
3. Storage packing: the two new bools pack into the final V3 word (with `ariseModule`/`initialized`) in previously-zero bytes; `sensitiveOpNonce` takes a fresh slot. Proven safe by `test_v4_storageLayout_noCollision` (enabling the locks leaves `guard`/`ariseModule`/`initialized` byte-identical).

## Decisions I need from you before coding

1. One flag or two: a single `sensitiveOpLock` governing both control ops and large sends, or a separate `emailLargeSendLock` so a user can protect control ops without adding friction to every large send. Recommendation: two independent flags, because the friction profiles differ (control ops are rare, large sends can be frequent).
2. G2 ERC-20 scope: support ERC-20 large sends from day one (in-account decode, more audit surface), or ship ETH-only first and revert locked ERC-20 large sends until supported. Recommendation: revert locked ERC-20 large sends until the decode is audited, so nothing is silently unprotected.
3. Storage packing: confirm via `forge inspect` whether `sensitiveOpLock` can pack with `initialized` without disturbing V1/V2/V3 reads, or give it its own word. I will verify before writing code.

## Full test list (fork suite unless noted)

The load-bearing tests are the adversarial ones in group 3. Every test names its pass condition.

### 1. Storage and migration
- `test_v4_readsV3Storage_flagsDefaultFalse`: a V3-initialized account re-delegated/upgraded to V4 reads `sensitiveOpLock == false`, `sensitiveOpNonce == 0`, and keeps its passkey, nonce, guard, arise wiring.
- `test_v4_unlocked_behavesLikeV3`: with the lock off, `setGuard` and `upgradeTo` (with `code == ""`) work exactly as V3; a normal send works; gas reimbursement unchanged.
- `test_v4_storageLayout_noCollision`: `forge inspect` layout assertion that the new fields sit after the V3 fields and no existing slot moved.

### 2. Enable / disable
- `test_enableLock_passkeyOnly_setsFlag`: self-call `enableLock()` sets the flag; a non-self caller reverts `NotSelf`.
- `test_disableLock_requiresEmailCode_whenLocked`: with the lock on, `disableLock("")` reverts (no code); `disableLock(validCode)` clears the flag and increments the nonce.
- `test_disableLock_passkeyOnly_cannotBypass`: a self-call `disableLock` with a wrong/expired/reused code reverts; the flag stays on.

### 3. Adversarial (the load-bearing group), passkey-only attacker, lock ON
- `test_attacker_setGuard_noCode_reverts`: passkey-signed `execute([setGuard(permissive, "")])` reverts; guard unchanged.
- `test_attacker_setGuardZero_noCode_reverts`: same for `setGuard(address(0), "")`.
- `test_attacker_upgradeTo_noCode_reverts`: passkey-signed `execute([upgradeTo(malicious, "")])` reverts; implementation slot unchanged.
- `test_attacker_disableLock_noCode_reverts`: passkey-only `disableLock("")` reverts; lock stays on.
- `test_attacker_largeSend_noCode_reverts` (if transfer factor on): large unverified send without a valid send-code reverts before funds move.
- `test_attacker_wrongDomainCode_reverts`: a code minted for `setguard:guardA` cannot authorize `setGuard(guardB)`, `upgradeTo`, or `disableLock` (domain binding); each reverts `CodeNotFound`.
- `test_attacker_staleNonceCode_reverts`: a code minted at nonce N is rejected after any op consumed a code and advanced the nonce.
- `test_attacker_replayConsumedCode_reverts`: re-submitting a consumed code reverts `CodeAlreadyUsed`.

### 4. Positive (both factors present)
- `test_setGuard_withEmailCode_succeeds`: self-call `setGuard(newGuard, validCode)` sets the guard, consumes the code, increments the nonce.
- `test_upgradeTo_withEmailCode_succeeds`: installs the new impl, consumes the code, state survives.
- `test_largeSend_withEmailCode_succeeds` (if transfer factor on): the send completes and consumes the send-code bound to that exact recipient+value; a second send needs a fresh code.
- `test_sendCode_boundToRecipientAndValue`: a send-code minted for (R, V) cannot authorize (R, V') or (R', V).

### 5. Recovery survives a locked, passkey-compromised account (must-pass)
- `test_arise_stillRotates_whenLocked`: with `sensitiveOpLock == true`, the full Arise flow (email recovery code -> `rotatePasskey`) still rotates the key. The lock does not gate recovery.
- `test_rotatePasskey_notGatedByLock`: `rotatePasskey` called by the AriseModule succeeds regardless of the lock; called by anyone else still reverts `NotAriseModule`.

### 6. Guardian policy (off-chain, integration)
- `guardian_opCode_emailedOnly_neverReturned`: `POST /op/request-code` returns a generic ack; the code appears only in the sent email, never in any response body or log.
- `guardian_opCode_requiresRecoveryEmail`: refused cleanly for an account with no recovery email.
- `guardian_opCode_passkeyGatedAndRateLimited`: unauthenticated or over-limit requests are refused; a passkey-only attacker can trigger a request but cannot read the emailed code.
- `guardian_opCode_domainMatchesAccountNonce`: the minted domain includes the account's current `sensitiveOpNonce`, so the account's check matches.

## Honest limits (for SECURITY.md once shipped)

- Survives a stolen passkey. Does NOT survive an attacker who also controls the recovery email, nor a compromise of the guardian process together with its email inbox (the guardian mints all codes and can reach the inbox). This is inherent to a 2-of-2 where one factor is email routed through the guardian.
- Off by default. Requires a registered recovery email. Enabling is one passkey tap; disabling requires the email code (so a passkey-only attacker cannot turn it off).
- A locked account with no reachable recovery email can only change its guard/impl through Arise-then-disable, or not at all. The app must prevent enabling the lock without a working recovery email.
