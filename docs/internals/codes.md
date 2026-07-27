# Verified codes and delivery

Suho uses one-time codes for **account recovery** (Arise). A code is an attestation on EAS, issued by the Suho code attester.

> **Note — transfers no longer use a code.** A large transfer to an unverified address is *not* gated by a one-time code. Earlier it was, but the guardian minted that code automatically from the same passkey signature that authorized the send, so it added no independent security while appearing to. It was removed. A large unverified send is now gated by the account's passkey (bound to the exact recipient and amount) plus an explicit hold-to-confirm in the app. See [Send and the guard](/using/send). A genuine out-of-band factor for large sends — an emailed code that survives a stolen passkey — is planned as account-level hardening and is deliberately absent until it can be built so nothing bypasses it.

## What a code is

`SuhoCodeAttester` issues a code as a revocable EAS attestation. The stored value is a hash, not the code itself. The hash is `keccak256(subject, domain, code)`.

The domain binds the recovery code to a purpose.

- Recovery: `suho.arise:<account>:<newKeyHash>`

Because the code hash commits to the domain, a code observed in the mempool is useless for any other account or action. `verifyAndConsume` checks that the attestation exists, is unrevoked, is unexpired, and is unused, then marks it consumed. Re-issuing for the same subject and domain revokes the old code on chain.

## Delivery — email only

Recovery codes are delivered **out of band, to the account's recovery email**. There is no public code page: the old `/issuer` portal is retired (it would have been an account-takeover surface), and its route now returns HTTP 410. Operators watch activity through the token-gated `/ops` endpoint, which never shows a code or an email.

The design reason for out-of-band delivery is the whole point: a drainer in the browser cannot produce a code it never received.

## Expiry

Recovery codes last ten minutes. Entering an expired code maps to a plain sentence: "Code expired. Request a fresh one."
