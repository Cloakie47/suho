# Send and the guard

Sending is where Suho earns its name. The wallet resolves who you are paying and warns you before you pay a stranger.

## Sending to a name

Type a up.id name or a 0x address in the recipient field. The app resolves it live, with a short debounce.

- **Verified human.** The recipient card shows a red seal and "Verified human". Enter an amount and send.
- **Unverified address.** The card shows an amber warning: "Unverified address. Suho can't identify who this is."

Enter the amount and tap Send. Complete the passkey prompt. A toast tracks the transaction: pending, then "Sent" with the real measured confirmation time, then "Confirmed" with an explorer link.

A verified send is proven live. [View the transaction.](https://sepolia-explorer.giwa.io/tx/0x5140fa4f8d3081b8f1accd82b1df4c157410cd055c888aead21463ff1263c8ec)

## The guard

Every transfer passes through `OndolTransferGuard` before it runs. The guard decides one of three outcomes.

- **Verified recipient.** Allowed silently.
- **Unverified recipient, small amount.** Allowed with a warning event. The app shows the amber card. The chain does not block small sends.
- **Unverified recipient, large amount.** Held for a one-time code. The threshold is 0.01 ether.

A small warned send is proven live. [View the transaction.](https://sepolia-explorer.giwa.io/tx/0xf1ab1cdc2243ea49fc054a4b6fd4e54edb6bde80be7d04be6494d8fc37bf300d)

## The one-time code

For a large transfer to a stranger, an interstitial appears with six code boxes and a countdown. The code is on the [verification service](/internals/codes). It is single-use and bound to this exact recipient and amount.

A drainer that observes the code cannot reuse it. The binding is `suho.guard:<account>:<recipient>:<amount>`. Enter the code and send.

If the code expires while the interstitial is open, the submit button becomes "Request a new code".

An OTP-gated send is proven live. [View the transaction.](https://sepolia-explorer.giwa.io/tx/0x3c3fb31d608d984388cdadc37e81dcf9f631412542a1d83f6b3e67782ca24b03)
