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
- **Unverified recipient, large amount.** Allowed only after an explicit hold-to-confirm, then your passkey. The threshold is 0.01 ether. The guard emits a loud `UnverifiedLargeSend` event so the send is never silent.

A small warned send is proven live. [View the transaction.](https://sepolia-explorer.giwa.io/tx/0xf1ab1cdc2243ea49fc054a4b6fd4e54edb6bde80be7d04be6494d8fc37bf300d)

## The large-send confirmation

For a large transfer to a stranger, an interstitial appears with a **hold-to-confirm** button. Hold it for a moment, then approve with your passkey. That is the whole gate.

Being honest about what protects you here: **there is no one-time code, and the barrier is your passkey.** Your passkey signature is cryptographically bound to this exact recipient and amount (the account's execute challenge covers the call), so it authorizes *this transfer and no other*. The hold-to-confirm is deliberate friction — it stops a large send to a stranger from happening on a stray tap or a hurried moment — not a second factor.

An earlier version issued a "one-time code" here. It was removed because the guardian minted that code automatically from the same passkey signature that authorized the send: the same key produced both, so the code added no independent security while appearing to. Suho does not ship security theater. A **real** second factor — an out-of-band code delivered to your recovery email, which survives a stolen passkey — is planned as account-level hardening (see the security notes); it is deliberately absent until it can be built so nothing can bypass it.

The on-chain behavior — a large unverified send completes on passkey authority, emits `UnverifiedLargeSend`, and consumes no code, while the same send with a wrong passkey reverts — is proven by the guard fork tests (`contracts/test/OndolGuard.t.sol`).
