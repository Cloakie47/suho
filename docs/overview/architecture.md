# Architecture

Suho has three parts. A browser app, a guardian service, and contracts on GIWA Sepolia. The browser holds the keys. The guardian relays and pays gas. The contracts enforce the rules.

## The pieces

```
[ Browser: Suho app ]
   passkey signatures (WebAuthn, P-256)
        │  REST
        ▼
[ Guardian service (Node, viem) ]
   holds a relayer key for gas and the code-issuer key. Never a user key.
        ▼
[ GIWA Sepolia ]
   normal RPC for writes, Flashblocks RPC for reads and receipts
        ├─ OndolAccountV2   the smart account (EIP-7702 + passkeys)
        ├─ OndolTransferGuard   verified pass, strangers warn or need a code
        ├─ AriseModule   passkey rotation via single-use codes
        ├─ SuhoCodeAttester   codes as EAS attestations
        └─ Dojang, EAS, UpnameRegistry   GIWA contracts, never mocked
```

## The browser holds the keys

A passkey lives in your device credential manager. It signs an assertion over each batch of calls. The app packages the assertion and sends it to the guardian. The app never sends a private key anywhere.

The account challenge is `keccak256(account, chainId, nonce, calls)`. A signature works for exactly one account, on one chain, at one nonce, for one batch. A relayer cannot tamper, replay, or redirect a signed batch.

## The guardian relays

The guardian holds a relayer key that pays gas, and the issuer key that mints verification codes. It exposes a small REST surface: onboard, relay, request a code, verify-me, claim-name, status, directory, card, and the issuer portal.

The guardian never receives key material on any endpoint. A request-body check rejects anything key-shaped before any handler runs.

## The contracts enforce

`OndolAccountV2` verifies the passkey signature on chain through the P256VERIFY precompile before running any call. `OndolTransferGuard` decides pass, warn, or require a code. `AriseModule` rotates the passkey only after a purpose-bound code is consumed. `SuhoCodeAttester` records codes as revocable EAS attestations.

See [The Ondol account](/internals/ondol-account) for the account internals.
