# Contracts and addresses

All contracts are live on GIWA Sepolia (chain id 91342). All four Suho contracts are source-verified on the explorer.

## Suho contracts

| Contract | Address |
| --- | --- |
| SuhoCodeAttester | [`0x88645529532844C380b40AB68E335CC7a8a0f63B`](https://sepolia-explorer.giwa.io/address/0x88645529532844C380b40AB68E335CC7a8a0f63B) |
| OndolTransferGuard | [`0x106953DB14B1183378976E128AE5cd40C4b493d2`](https://sepolia-explorer.giwa.io/address/0x106953DB14B1183378976E128AE5cd40C4b493d2) |
| AriseModule | [`0x827375200CF4595f71b09497A65BAF10Ca907466`](https://sepolia-explorer.giwa.io/address/0x827375200CF4595f71b09497A65BAF10Ca907466) |
| OndolAccount v1 (superseded) | [`0xD9933BEfC6C6ff968c662c30c765Ce9740aD8Ec4`](https://sepolia-explorer.giwa.io/address/0xD9933BEfC6C6ff968c662c30c765Ce9740aD8Ec4) |
| OndolAccountV2 (current) | [`0xC512B2B083a38aa75F20E947feC5ee22AA23Bd69`](https://sepolia-explorer.giwa.io/address/0xC512B2B083a38aa75F20E947feC5ee22AA23Bd69) |

## GIWA contracts used

| Contract | Address |
| --- | --- |
| DojangScroll | [`0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9`](https://sepolia-explorer.giwa.io/address/0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9) |
| UpnameRegistry | [`0x091D00004f21eb2Fc30964A8a4995692d9b49628`](https://sepolia-explorer.giwa.io/address/0x091D00004f21eb2Fc30964A8a4995692d9b49628) |
| GIWAFaucetExtension (issuer) | [`0x63CCe2b569A7bC35895ee24306c1512fefc06121`](https://sepolia-explorer.giwa.io/address/0x63CCe2b569A7bC35895ee24306c1512fefc06121) |
| EAS (predeploy) | `0x4200000000000000000000000000000000000021` |
| SchemaRegistry (predeploy) | `0x4200000000000000000000000000000000000020` |

## Schemas

- **Verified code**: `bytes32 codeHash, string domain`. UID `0x8f05c451eccf1fe63ba0518ad1f3338b92b7516eec60ea8ea9e528b20e49a3cf`. Resolver 0, revocable.
- **Suho Card**: `string displayName, string contact, string remarks`. UID `0x1eb6f3a6fefafeb323d44868d7c4c97ee64c981d9c47c5f028154a29dba0bdaa`. Resolver 0, revocable.

## Config

- Guard OTP threshold: 0.01 ether.
- Accepted attester ids from `DojangConfig`: testnet faucet first, Upbit Korea second.
- Chain: GIWA Sepolia. Normal RPC `https://sepolia-rpc.giwa.io`. Flashblocks RPC `https://sepolia-rpc-flashblocks.giwa.io`. Explorer `https://sepolia-explorer.giwa.io`.

## The proof

Every milestone is a live transaction.

| Milestone | Transaction |
| --- | --- |
| Account upgraded in place (7702 + passkey init) | [`0x5e6e…35ef`](https://sepolia-explorer.giwa.io/tx/0x5e6e4b14af7ad84dda9cc525ff43be0ac1922e3e70b8be66e0ecdbd2656835ef) |
| Send to a verified name | [`0x5140…c8ec`](https://sepolia-explorer.giwa.io/tx/0x5140fa4f8d3081b8f1accd82b1df4c157410cd055c888aead21463ff1263c8ec) |
| Small send to a stranger, warned | [`0xf1ab…300d`](https://sepolia-explorer.giwa.io/tx/0xf1ab1cdc2243ea49fc054a4b6fd4e54edb6bde80be7d04be6494d8fc37bf300d) |
| Large send, held for a code | [`0x3c3f…4b03`](https://sepolia-explorer.giwa.io/tx/0x3c3fb31d608d984388cdadc37e81dcf9f631412542a1d83f6b3e67782ca24b03) |
| Arise, passkey rotated | [`0x3677…6bc3`](https://sepolia-explorer.giwa.io/tx/0x36770b1bc51c3b6972bb50b5b5d36b65e52121867fc8e1f90d4f254e85676bc3) |
| Upgraded v1 to v2 in place | [`0x2a24…98af`](https://sepolia-explorer.giwa.io/tx/0x2a24fa95278db11517d9af46e9b43d9046784d82ab1f1cdec0972bd6316598af) |
| Stranger onboarded gasless | [`0xf00b…ce42`](https://sepolia-explorer.giwa.io/tx/0xf00bd017430c9e0d6d25afc389767410f0a923820f0b701cdd7f7ce0b50bce42) |
| Card self-attested through the account | [`0x5cbf…b167`](https://sepolia-explorer.giwa.io/tx/0x5cbfba2ea0e076948d6eeb411c349f47cb0b4fa91339cf3321098e1df08ab167) |
