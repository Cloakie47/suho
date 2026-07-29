# Suho Roadmap

Suho today is a guardian wallet on GIWA. It ships passkey accounts with gasless non-custodial onboarding, sends to up.id names instead of addresses, guards transfers against unverified recipients, recovers lost devices by email, and issues attested identity cards with on-chain version history. All of it runs live on GIWA Sepolia with verified contracts.

The roadmap builds on one architectural fact. Suho is not only a wallet. It is a trust layer. Every account is a provably unique, KYC-attested human, and every transaction passes through a guard. The work ahead extracts that layer into infrastructure, makes verification portable, and builds finance that depends on it.

Three horizons follow, ordered by dependency.

## Horizon 1: Ondol SDK

Suho's account layer is already a separable module. It handles EIP-7702 delegation, WebAuthn passkey signing verified on-chain via the P256 precompile, gasless relaying with signed gas caps, the transfer guard, and Arise recovery. Horizon 1 packages it as `@suho/ondol` so any GIWA project can adopt passkey onboarding without building it.

The concrete work:

1. Publish `@suho/ondol`: create a passkey account, sign transactions, recover a device, all client-side and non-custodial.
2. Add ERC-1271 (`isValidSignature`) to the account contract, verifying WebAuthn signatures on-chain. This makes Ondol accounts work with any dApp that checks message signatures, which is the prerequisite for DEXes, marketplaces, and Permit2 flows.
3. Offer a hosted guardian so integrators do not run their own relayer and paymaster.

The account layer is built and tested with 53 passing fork tests. ERC-1271 is a scoped contract addition using the same P256 verification already deployed. This horizon is packaging plus one interface, not new research.

The point: a new chain loses users at onboarding because of seed phrases and hostile key management. Ondol removes that wall for every GIWA project at once. Suho becomes the onboarding standard for the ecosystem rather than a single app competing for users.

## Horizon 2: The verified-human network

Horizon 2 makes verification useful across apps and between people.

Sign in with Suho. A dApp adds one button and knows every user is a unique KYC-attested human. This ends Sybil-farmed airdrops, bot-driven governance, and fake-account abuse at the identity layer instead of with heuristics. Verification happens once and is readable by any app on-chain.

A trust-ranked dApp directory. A discovery surface for GIWA dApps where users connect their Suho wallet directly, and where verified apps and verified counterparties are marked. It is a map of the ecosystem ranked by trust, not a flat list.

Verified peer-to-peer transfers. OTC-style transfers between KYC'd counterparties, where both sides see each other's verified identity before funds move. This targets the P2P scam problem directly, because the counterparty is a provable person rather than an anonymous address.

Guarded dApp interactions. The transfer guard extends from who you pay to what you sign. Once Suho connects to dApps over WalletConnect, it inspects calldata and warns about malicious contracts and unlimited token approvals, the same way it warns about unverified recipients today. The guard covers the whole on-chain surface, not only payments.

None of these are buildable on a chain without a KYC-attestation primitive. Dojang plus Suho is the only place they can exist.

## Horizon 3: Guarded, verified finance

Horizon 3 puts consumer finance on the trust layer, where each feature inherits verification and guarding.

Guarded swaps that warn before interaction with an unverified or malicious pool. Prediction markets and perps where counterparties and market creators can be verified humans, cutting manipulation and wash trading. Proof-of-funds credit built on Dojang's Verified Balance attestation, which enables undercollateralized lending backed by a cryptographically proven balance rather than a multisig promise.

These come last on purpose. They carry the highest value and the highest surface area, and they are only differentiated because they sit on the verified, guarded foundation below. A swap on Suho is worth building because it is a guarded swap between verified parties. Built before the foundation, these would be weaker copies of existing DEXes and markets. Built after, they are a category no one without an identity layer can enter.

## The through-line

Every horizon compounds the same property. Suho knows which accounts are real humans, and it guards what they do. The SDK spreads that to every app. The network makes verification portable and valuable. Finance monetizes it. None of it works without the trust layer, which is what Suho has already built and proven live on GIWA Sepolia.

Horizon 1 is the wedge. It turns Suho from a product into infrastructure the GIWA ecosystem onboards through, and it is the shortest path from a working wallet to a layer other builders depend on.
