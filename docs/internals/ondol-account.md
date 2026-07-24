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

## Upgradeable accounts (the proxy and V3)

An onboarded user's bootstrap key is destroyed after two signatures. That is good for custody, but it means the 7702 delegation can never be re-signed, so an account delegated straight to an implementation is pinned to that implementation forever. To restore an upgrade path the account controls, new accounts delegate to a small proxy instead of straight to an implementation.

`OndolProxy` holds one storage slot, the ERC-1967 implementation pointer, and forwards everything else to the implementation it points at. Because the pointer lives in the account's own storage, the account can move to a new implementation without a new 7702 authorization. `OndolAccountV3.upgradeTo` writes that pointer, and it is reachable only through a passkey-signed `execute()` batch that targets the account itself. The passkey is the only upgrade authority. There is no admin, owner, or guardian.

Installing the implementation is authorized by the account's own key, one time, as with V2. The key signs which implementation the proxy may install. This matters because 7702 authorizations are replayable from the mempool: without the signature an attacker could re-attach the delegation and point the account at a hostile implementation. With it, an attacker can set neither the implementation nor the passkey.

V3 also reimburses gas. `execute()` pays whoever paid the gas up to a cap the passkey signed, so a relayer can be made whole without being able to inflate the charge. A cap of zero is the sponsored path, identical to V2, and is what onboarding uses.

## Migration reality

- **Accounts with a live key (alice).** Delegated straight to V1 or V2, with the EOA key still held. These can re-delegate to the proxy and become upgradeable.
- **Accounts from gasless onboarding.** The bootstrap key was destroyed, so the delegation cannot be re-signed. These stay on V2 permanently. They keep working, but they cannot receive future upgrades. Suho shows them a note and suggests moving funds to a new account when convenient.
- **Accounts from here on.** Proxy-fronted from creation, upgradeable by their own passkey.

`/status` reports the delegation shape and whether an account is upgradeable, so the app can show the right state for each.

Contract addresses are on the [Contracts and addresses](/developers/contracts) page.
