# The Ondol account

The Ondol account is a smart account at your own address. It uses EIP-7702 to place code at an existing address, and a passkey to authorize day-to-day calls.

## EIP-7702 in place

A normal account is an EOA controlled by a secp256k1 key. EIP-7702 lets that address delegate to a contract implementation. The address keeps its history, its name, and its Dojang verification. It gains smart-account behavior at the same address.

On GIWA Sepolia the delegation shows up as a code designator. It reads `0xef0100` followed by the implementation address. Delegation can be cleared by authorizing the zero address, which was verified live during our probes.

## Passkeys authorize

Once delegated, day-to-day operations are authorized by a passkey, not the original key. A passkey is a WebAuthn P-256 credential in your device credential manager.

`execute()` verifies the WebAuthn assertion on chain. It checks the assertion over the account challenge, then runs each call through the guard. The signature is verified through the P256VERIFY precompile, a native precompile on GIWA. The challenge is `keccak256(account, chainId, nonce, calls)`, so a signature is good for one account, one chain, one nonce, one batch.

Fork tests prove that a malicious relayer cannot tamper with a batch, replay a signature, or redirect it.

## V2 and gasless onboarding

The current implementation is `OndolAccountV2`. It adds `initializeWithSig`, a signature-gated setup. A relayer can initialize a fresh account with an EIP-712 signature from the account's own key. The fresh account needs no gas.

The domain binds the chain id and the account address, so a setup signature cannot replay across chains or onto another account. Low-s is enforced, matching the malleability rule on the P-256 side.

V2 keeps the exact storage layout of v1. An account initialized under v1 re-delegates to v2 and keeps its passkey, nonce, and wiring with no re-initialization. The alice account was migrated live. [View the re-delegation transaction.](https://sepolia-explorer.giwa.io/tx/0x2a24fa95278db11517d9af46e9b43d9046784d82ab1f1cdec0972bd6316598af)

Contract addresses are on the [Contracts and addresses](/developers/contracts) page.
