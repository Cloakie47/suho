# Accounts on this device

There is no logout in Suho. There are no sessions. There are accounts on this device. The sidebar identity card opens the account switcher.

## Switching

The switcher lists every account this browser knows. Each row shows a seal or a gray dot, the name or address, and which passkey is linked. The current account is checked.

Tap a row to switch. Switching just changes the active account. It signs nothing.

## Add account

- **Add account.** Runs onboarding to create a new account.
- **Add existing account.** Enter the address of a Suho account you already have. The app checks that it is a real Suho account on chain, then links a passkey to it.

## Linking a passkey

An account with no linked passkey on this device shows a Link button. Linking is a one-time re-attach. You pick a passkey, and the app verifies its signature against the account's on-chain key before storing anything. A wrong pick is never saved and never reaches a transaction.

If no passkey on this device matches, the app offers **Recover with Arise**. That is the only time Arise enters a normal switch. Switching and linking never need recovery.

Linking works from a fully cleared cache. Everything is reconstructed from chain plus a passkey pick.

## Forget an account

Each row has a small remove action, behind a confirmation. It forgets the local entry only. The account itself lives on chain. Your passkey stays in the device credential manager.

## About credentials

Suho stores one passkey credential id per account. It is public data, not key material. This per-account mapping is why a signature is always pinned to the right account after you switch.
