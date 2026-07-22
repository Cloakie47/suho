# Verified codes and the issuer

Suho uses one-time codes for two things: large transfers to strangers, and account recovery. A code is an attestation on EAS, issued by the Suho code attester.

## What a code is

`SuhoCodeAttester` issues a code as a revocable EAS attestation. The stored value is a hash, not the code itself. The hash is `keccak256(subject, domain, code)`.

The domain binds the code to a purpose.

- Transfer: `suho.guard:<account>:<recipient>:<amount>`
- Recovery: `suho.arise:<account>:<newKeyHash>`

Because the code hash commits to the domain, a code observed in the mempool is useless for any other account or action. `verifyAndConsume` checks that the attestation exists, is unrevoked, is unexpired, and is unused, then marks it consumed. Re-issuing for the same subject and domain revokes the old code on chain.

## The verification service

Codes are delivered out of band. In the app, that channel is a page served by the guardian at `/issuer`, styled as the Verification Service. It lists active codes per account, each with a live countdown. Click a code to copy it.

The page carries one honest line. On mainnet, codes are delivered by the issuer's own app. This page simulates that channel for the testnet issuer.

The console and a local log stay as fallbacks. The design reason for keeping delivery out of band is the whole point: a drainer in the browser cannot produce a code it never received.

## Expiry

Codes last ten minutes. If a code expires while an input is open, the app disables submit and offers to request a new one. Entering an expired code maps to a plain sentence: "Code expired. Request a fresh one."
