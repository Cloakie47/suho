# Your Card

The Suho Card is an attested identity card. Your account signs it. The seal attests the human. The fields are your own claims.

## What the card holds

- A display name, a contact, and a remarks line.
- The red seal, if your account is Dojang-verified.
- Your up.id name.
- A version number and the attestation id.
- A QR code linking to your account on the explorer.

The card renders at credit-card proportion. It carries one honest line in small print: identity is verified by Dojang; card fields are self-declared by the verified owner. The seal attests the human. The fields are their claims. Do not blur the two.

## How versions work

The card is an attestation on EAS, made by your account itself. Not by a guardian key. Every version is passkey-signed.

An edit is one batch: attest the new version, then revoke the old one. The two happen together. Nothing is ever deleted. The new attestation points at the old one, so the version history is a walkable chain.

The Versions panel shows each version with its timestamp. The current one is a filled seal dot. A revoked one is a hollow dot with its revocation time.

A self-attested card is proven live. [View the transaction.](https://sepolia-explorer.giwa.io/tx/0x5cbfba2ea0e076948d6eeb411c349f47cb0b4fa91339cf3321098e1df08ab167)

## Sharing

Each card has a read-only verify view at `/verify/<address>`. It resolves live: Dojang status, active up.id, current card fields, and the version history. It needs no passkey and no session, so it is safe to share.
