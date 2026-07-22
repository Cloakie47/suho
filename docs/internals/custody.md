# Custody and threat model

New-user onboarding is non-custodial end to end. No private key ever leaves the browser. This page is honest about what that means, including the limits.

## The bootstrap key

EIP-7702 needs a secp256k1 signature to authorize the delegation and the first passkey. The browser generates a one-time bootstrap key for that.

The key is generated in a function closure. It signs exactly two things: the 7702 authorization and the EIP-712 digest that binds the first passkey. Then every reference to it is dropped.

- It is never placed in application state.
- It is never rendered or logged.
- It is never written to storage of any kind.
- It is never sent over the network. Only the signatures travel.

The guardian relays one transaction and pays its gas. A request-body check rejects anything key-shaped on every endpoint, before any handler runs.

## The 7702 root-key note

Be honest about the design. By EIP-7702's rules, the secp256k1 key remains the theoretical root authority of the address. Ours is generated in the tab, used once, and garbage collected. It is unrecoverable and un-persisted, by us or by anyone.

The practical threat model is the browser session during those milliseconds of signing. After that, key compromise is impossible, because the key no longer exists. Recovery from then on runs through Arise's purpose-bound single-use codes while the testnet issuer operates.

## After onboarding

The passkey is the sole practical authority. Every operation is passkey-signed. The guardian is a relayer. The contracts enforce this, and the fork tests prove a malicious relayer cannot tamper, replay, or redirect a signed batch.

## The legacy demo path

The alice account predates this flow. The guardian held its key for the original one-time upgrade, and for its final legacy use, the v1 to v2 re-delegation. The app labels this path as legacy.

## Existing wallets

Upgrading an existing wallet, where a user delegates their own Rabby or MetaMask account, is pending wallet-side EIP-7702 authorization support. This is stated, not promised.
