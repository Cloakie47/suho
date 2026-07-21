# Suho deployments — GIWA Sepolia (chain ID 91342)

Deployed 2026-07-20 with `evm_version = "osaka"` bytecode (solc 0.8.30); deployed
and executed without incident. Deployer/issuer key: `DEPLOYER_*` in `.env`
(owner of SuhoCodeAttester).

| Contract | Address | Explorer | Source verified |
|---|---|---|---|
| SuhoCodeAttester | `0x88645529532844C380b40AB68E335CC7a8a0f63B` | [view](https://sepolia-explorer.giwa.io/address/0x88645529532844C380b40AB68E335CC7a8a0f63B) | ✅ 2026-07-21 (Blockscout, Pass) |
| OndolTransferGuard | `0x106953DB14B1183378976E128AE5cd40C4b493d2` | [view](https://sepolia-explorer.giwa.io/address/0x106953DB14B1183378976E128AE5cd40C4b493d2) | ✅ 2026-07-21 (Blockscout, Pass) |
| AriseModule | `0x827375200CF4595f71b09497A65BAF10Ca907466` | [view](https://sepolia-explorer.giwa.io/address/0x827375200CF4595f71b09497A65BAF10Ca907466) | ✅ 2026-07-21 (Blockscout, Pass) |
| OndolAccount (impl) | `0xD9933BEfC6C6ff968c662c30c765Ce9740aD8Ec4` | [view](https://sepolia-explorer.giwa.io/address/0xD9933BEfC6C6ff968c662c30c765Ce9740aD8Ec4) | ✅ 2026-07-21 (Blockscout, Pass) |

Suho code schema UID (registered on the SchemaRegistry predeploy, resolver 0,
revocable): `0x8f05c451eccf1fe63ba0518ad1f3338b92b7516eec60ea8ea9e528b20e49a3cf`
— schema `bytes32 codeHash, string domain`.

Config: guard `otpThreshold` = 0.01 ether; accepted attester IDs from
`DojangConfig` (TESTNET FAUCET first, UPBIT KOREA second).

Post-deploy smoke test (live, both txs status 1): issued a throwaway code to
alice under domain `suho.test:roundtrip-1`, `isCodeActive` true, then
`verifyAndConsume` consumed it, `isCodeActive` false.

Note: the OndolAccount implementation is deployed but NO wallet is 7702-delegated
to it yet — that happens in the app phase.
