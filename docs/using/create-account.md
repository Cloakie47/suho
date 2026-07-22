# Create an account

A fresh browser can become a verified, named account in a few taps. You need no wallet, no extension, and no ETH to start.

## The flow

1. Open the app. A fresh profile shows **Create your Suho account**.
2. Tap it and complete the passkey prompt. This is your key. No seed phrase is ever made.
3. Your account exists. The screen shows your address, "Not yet verified", and a zero balance.
4. A guided checklist appears on the home screen.

The checklist has four steps. Each is a real on-chain milestone that flips to a seal when done.

- **Fund.** Send a little testnet ETH from a faucet. The balance updates live.
- **Get verified.** Your account attests itself with the testnet issuer. This costs a small fee and is passkey-signed.
- **Claim your name.** Pick a up.id. The account claims it, so the name is owned by you.
- **Send your first transfer.** Try a verified name and watch the seal resolve.

## What happens under the hood

When you tap create, the browser generates a one-time key, uses it to sign two things, and destroys it. The two signatures authorize the account and bind your passkey to it. The guardian submits one transaction and pays the gas.

The account is born at its own address, already a smart account. From then on your passkey is the authority. See [Custody and threat model](/internals/custody) for why the one-time key is safe.

Onboarding was proven live. [View the activation transaction.](https://sepolia-explorer.giwa.io/tx/0xf00bd017430c9e0d6d25afc389767410f0a923820f0b701cdd7f7ce0b50bce42)

## The demo account

The app ships with a demo account (alice.up.id) on a clearly labeled legacy path. Use it to explore without onboarding. New accounts always use the current flow above.
