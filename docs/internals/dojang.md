# Dojang and attesters

Dojang is GIWA's verified-address system. Suho reads it to decide who is a verified human. It never mocks these reads.

## How verification is read

A recipient is verified if `DojangScroll.isVerified(address, attesterId)` returns true for any accepted attester. Suho accepts two attester ids, in order: the testnet faucet issuer first, and the Upbit Korea issuer second.

The attester id is configuration, not a constant baked into the guard. It lives in `DojangConfig` and is passed to the guard at deploy time. No contract hardcodes an attester id anywhere else.

## up.id names

Names come from the UpnameRegistry, the "Upbit Web3 Names" contract. It is not ENS-style. There is no separate resolver and no namehash.

The token id is the keccak hash of the bare label. Forward resolution reads `ownerOf(tokenId)`. Reverse resolution reads the label for the token owned by an address. A name is only shown when its owner has an active name.

## In-app verification

New accounts verify themselves. The app builds a Dojang faucet-issuance call and routes it through the account's own `execute()` with a passkey signature. The account performs its own verification. The guardian only relays.

Verification is a third-party attestation by nature, so the issuer being a fixed testnet attester is honest. The name claim is different. It must come from the account itself, because the registry assigns the name to `msg.sender`.

Contract addresses are on the [Contracts and addresses](/developers/contracts) page.
