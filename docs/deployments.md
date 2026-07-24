# Suho deployments — GIWA Sepolia (chain ID 91342)

Deployed 2026-07-20 with `evm_version = "osaka"` bytecode (solc 0.8.30); deployed
and executed without incident. Deployer/issuer key: `DEPLOYER_*` in `.env`
(owner of SuhoCodeAttester).

| Contract | Address | Explorer | Source verified |
|---|---|---|---|
| SuhoCodeAttester | `0x88645529532844C380b40AB68E335CC7a8a0f63B` | [view](https://sepolia-explorer.giwa.io/address/0x88645529532844C380b40AB68E335CC7a8a0f63B) | ✅ 2026-07-21 (Blockscout, Pass) |
| OndolTransferGuard | `0x106953DB14B1183378976E128AE5cd40C4b493d2` | [view](https://sepolia-explorer.giwa.io/address/0x106953DB14B1183378976E128AE5cd40C4b493d2) | ✅ 2026-07-21 (Blockscout, Pass) |
| AriseModule | `0x827375200CF4595f71b09497A65BAF10Ca907466` | [view](https://sepolia-explorer.giwa.io/address/0x827375200CF4595f71b09497A65BAF10Ca907466) | ✅ 2026-07-21 (Blockscout, Pass) |
| OndolAccount (impl, v1 — superseded) | `0xD9933BEfC6C6ff968c662c30c765Ce9740aD8Ec4` | [view](https://sepolia-explorer.giwa.io/address/0xD9933BEfC6C6ff968c662c30c765Ce9740aD8Ec4) | ✅ 2026-07-21 (Blockscout, Pass) |
| OndolAccountV2 (impl — superseded, still supported for pinned accounts) | `0xC512B2B083a38aa75F20E947feC5ee22AA23Bd69` | [view](https://sepolia-explorer.giwa.io/address/0xC512B2B083a38aa75F20E947feC5ee22AA23Bd69) | ✅ 2026-07-21 (Blockscout, Pass) |
| OndolProxy (upgradeable 7702 target — current) | `0x5641D0D42bCD6450BE30077998Fe64F263A4887B` | [view](https://sepolia-explorer.giwa.io/address/0x5641D0D42bCD6450BE30077998Fe64F263A4887B) | ✅ 2026-07-24 (Blockscout, Pass) |
| OndolAccountV3 (impl — current) | `0xff164E70038EB91c342981d95f1f59d04499399E` | [view](https://sepolia-explorer.giwa.io/address/0xff164E70038EB91c342981d95f1f59d04499399E) | ✅ 2026-07-24 (Blockscout, Pass) |

Suho code schema UID (registered on the SchemaRegistry predeploy, resolver 0,
revocable): `0x8f05c451eccf1fe63ba0518ad1f3338b92b7516eec60ea8ea9e528b20e49a3cf`
— schema `bytes32 codeHash, string domain`.

Suho Card schema UID (registered 2026-07-21, block 31278333, resolver 0,
revocable): `0x1eb6f3a6fefafeb323d44868d7c4c97ee64c981d9c47c5f028154a29dba0bdaa`
— schema `string displayName, string contact, string remarks`. Card
attestations are self-attested by the Ondol account via execute() (passkey-
signed); versions chain through refUID, updates revoke the prior version.

Config: guard `otpThreshold` = 0.01 ether; accepted attester IDs from
`DojangConfig` (TESTNET FAUCET first, UPBIT KOREA second).

Post-deploy smoke test (live, both txs status 1): issued a throwaway code to
alice under domain `suho.test:roundtrip-1`, `isCodeActive` true, then
`verifyAndConsume` consumed it, `isCodeActive` false.

Phase O (2026-07-21): OndolAccountV2 replaces the self-call-gated initialize
with EIP-712 signature-gated `initializeWithSig` (low-s enforced) so a relayer
can initialize a gasless fresh account; storage namespace is identical to v1,
so v1-initialized accounts re-delegate to v2 with no re-initialization. v1
remains deployed and source-verified as superseded.

Phase G (2026-07-24): OndolProxy and OndolAccountV3 deployed (deploy txs
[`0x9aa7532d…`](https://sepolia-explorer.giwa.io/tx/0x9aa7532d8d591d5df0e161b8dd8c0bd06417cbf84efe282a6fe52e97b4d60c04)
and
[`0x4bb11d91…`](https://sepolia-explorer.giwa.io/tx/0x4bb11d919d9b19f1aaabc85958982edb8ce8541f4da746ee77ea04581b4912e7)),
both source-verified. New accounts delegate to **OndolProxy** and initialize
with **V3** behind it, so the passkey can later `upgradeTo` a new implementation.
V3 adds capped, passkey-signed gas reimbursement (`maxGasPayment`) and shares the
V1/V2 ERC-7201 storage layout. **V2 is superseded but still supported**: accounts
delegated straight to V2 (including gasless-onboarded accounts whose bootstrap key
was destroyed) keep working, but they are pinned and cannot upgrade. Accounts with
a live EOA key (alice) can re-delegate to the proxy. See the migration reality in
[The Ondol account](/internals/ondol-account).
