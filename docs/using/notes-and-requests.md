# Notes and return requests

Two ways to attach a message to a payment. A note rides along with the transfer. A return request follows one, after the fact.

## Notes

A note is a short message attached to a send. When you fill the note field, Suho appends a call to the [SuhoMemo](https://sepolia-explorer.giwa.io/address/0x6999248c4C7B45da530511BDe7E386084d3D9835) contract to the **same transaction** as the transfer. The note and the money move together in one passkey-signed transaction. One tap, one atomic send.

Notes are **public**. They are on-chain events, readable by anyone. The app says so at the point of entry: the field reads "Add a public note (visible on-chain)". Do not put anything private in a note.

- Up to 140 characters, plain text.
- Both the sender and the recipient see the note on the transaction row in Activity, because it is read straight from the chain. Suho indexes the `Memo` event by sender and recipient, so it appears for both parties without anyone storing it off-chain.
- The contract does nothing but emit the event. There is no state to read, nothing to delete, and no guardian in the path.

A note on chain: [`0x15ff…409f`](https://sepolia-explorer.giwa.io/tx/0x15ffe4e3166b8506a2663ea93fd62e0cd88b83123283eb0aaa9dd56e1e31409f).

## Return requests

A return request is a message you attach to a transfer **after** it settled: "I sent this by mistake, please send it back."

Being honest about what it is not: **Suho cannot reverse a transaction.** Nothing on chain is undone. A return request reaches the real person on the other side so you can ask. They choose whether to send it back. It is a way to reach a human, not a chargeback.

The rules, enforced by the guardian before anything is stored:

- **Anchored to a real transfer.** Every request references an on-chain transaction. The guardian verifies on chain that it exists and is a transfer from you to the recipient, before it will store a request.
- **Verified sender.** Only a Dojang-verified account (a KYC-attested human) can create a return request. The send itself is already proof you paid them.
- **Allowlisted tokens.** Native ETH today. The list is configurable, so canonical USDC can be added, but Suho does not hardcode a token address it cannot confirm as canonical.
- **One per transfer**, plus at most one reminder after seven days.
- Up to 280 characters, plain text.

## What the recipient sees

The recipient finds the request in Activity, with the chain-verified facts first (amount, token, who sent it, the transaction), then your message. They can:

- **Return funds.** Pre-fills a send back of the exact amount to you. One passkey tap. Both sides then show "Returned", confirmed by the guardian verifying the return transaction on chain.
- **Decline.** You see "declined".
- **Dismiss.** Hides it for them. You still see it as pending.
- **Block.** No future requests from that account reach them, silently.

## The privacy model

- **Notes are public chain data.** Anyone can read them. That is the point of putting them on chain, and the field says so.
- **Return requests are viewable by address** today. This is a deliberate "public for now" choice; a private channel is future work. Reading a request needs no passkey.
- **State changes are gated.** Declining, dismissing, or blocking needs your passkey (a short-lived, in-memory session). Returning funds is a normal passkey-signed send, and marking a request returned is verified on chain. The money and the truth never move without the real proof.

## Late arrival

Requests are keyed to the recipient's address. An address that joins Suho later still finds any request waiting the first time it opens Activity. You can request a return from someone who is not on Suho yet, and it is there when they arrive.
