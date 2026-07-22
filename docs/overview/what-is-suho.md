# What is Suho

Suho is a guardian wallet on GIWA Sepolia. It puts identity at the center of every payment. You send to names, not addresses. The wallet tells you who you are paying. You recover a lost device without a seed phrase.

The name is Korean. 수호 means to guard or protect. The visual language is Korean-modern: warm paper, ink text, one red seal.

## What it does

- **Send to names.** Type a up.id name. Suho resolves it on chain and shows a red seal if the recipient is a verified human.
- **Warn on strangers.** An unverified recipient shows an amber warning. Small sends still go through. Large sends stop for a code.
- **Recover with Arise.** Lost your device? Rotate to a new passkey with a single-use code. Your address and name stay the same.
- **Carry a Card.** An attested identity card, signed by your own account, with a walkable version history on EAS.

## What makes it different

Your account is a passkey-controlled smart account at your own address. There is no seed phrase. Day to day, a passkey signs every transaction. A guardian service relays those transactions and pays the gas. It never sees a private key.

New users start from nothing. A fresh browser becomes a verified, named account in a few taps. The one-time key that bootstraps the account is generated in the browser, used to sign twice, and destroyed. See [Custody and threat model](/internals/custody).

## Live on GIWA Sepolia

Every claim in these docs links to a real transaction. The account layer, the guard, recovery, and the identity card all run on GIWA Sepolia today. Contract addresses are on the [Contracts and addresses](/developers/contracts) page.
