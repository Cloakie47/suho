# Suho — Attestation Layer Spec (v2)

Supersedes the "Mock Dojang Attester" spec. Key finding: **Dojang issuance is open on GIWA Sepolia** via the Playground and a TESTNET FAUCET attester. No Verified Address mock is needed. We build against the real Dojang contracts; the only thing we deploy ourselves is our own recovery-code attester.

Target chain: **GIWA Sepolia** (chain ID `91342`, RPC `https://sepolia-rpc.giwa.io`, Flashblocks RPC `https://sepolia-rpc-flashblocks.giwa.io`, explorer `https://sepolia-explorer.giwa.io`)
Toolchain: **Foundry**, Solidity `^0.8.28`. Reference source: `github.com/giwa-io/dojang`.

## 0. Real contract addresses (GIWA Sepolia)

| Contract | Address |
|---|---|
| EAS (predeploy) | `0x4200000000000000000000000000000000000021` |
| SchemaRegistry (predeploy) | `0x4200000000000000000000000000000000000020` |
| DojangScroll | `0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9` |
| AttestationIndexer | `0x9C9Bf29880448aB39795a11b669e22A0f1d790ec` |
| DojangAttesterBook | `0xDA282E89244424E297Ce8e78089B54D043FB28B6` |

**Attester IDs (both live on testnet):**
- UPBIT KOREA: `0xd99b42e778498aa3c9c1f6a012359130252780511687a35982e8e52735453034`
- TESTNET FAUCET: `0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678`

**Official schema (for reference / future alignment):**
- Verified Code schema content: `bytes32 codeHash, string domain` (UID `0x55ac1369dac97522d062b89ffdc4e752b48fbeba86915fdb956c7c2d0501d280`) — issuance restricted to registered attesters via resolver; we do NOT attest under this schema.

## 1. Design rules

1. **Read real, never mock reads.** All verification checks go through the real `DojangScroll.isVerified(addr, attesterId)`.
2. **Attester ID is config, not constant.** `TESTNET FAUCET` for the hackathon demo; `UPBIT KOREA` for mainnet. Load from deployment config / immutable constructor arg. Consider accepting an *array* of attester IDs and returning true if any matches, so a wallet verified by either attester passes.
3. **We attest only under our own schema.** `SuhoCodeAttester` registers a Suho-owned schema shaped like Dojang's Verified Code, so a future migration to the official issuer is a schema-UID + attester swap.

## 2. Repo layout

```
contracts/
  src/
    interfaces/IDojangScroll.sol
    interfaces/IEAS.sol              // minimal: attest, revoke, getAttestation
    SuhoCodeAttester.sol             // our recovery/OTP attester (real, not mock)
    DojangConfig.sol                 // addresses + attester IDs per network
  script/
    DeploySuhoCodeAttester.s.sol
  test/
    DojangRead.t.sol                 // fork tests against real DojangScroll
    SuhoCodeAttester.t.sol
```

## 3. `IDojangScroll` (byte-identical to real)

```solidity
interface IDojangScroll {
    function isVerified(address addr, bytes32 attesterId) external view returns (bool);
    function getVerifiedAddressAttestationUid(address addr, bytes32 attesterId) external view returns (bytes32);
}
```

## 4. `SuhoCodeAttester`

Our own EAS schema for Arise recovery codes and high-risk-transfer OTPs. Uses EAS-native fields (recipient = subject, expirationTime = code expiry) so the custom data stays minimal and Dojang-shaped.

**Schema string:** `bytes32 codeHash, string domain` (identical shape to official Verified Code). Registered once by the deploy script on the real SchemaRegistry, resolver `address(0)`, revocable `true`.

**Purpose binding lives in `domain`:** format `"suho.arise:<account>:<newSignerHash>"` for recovery, `"suho.guard:<account>:<recipient>:<amountBucket>"` for transfer OTPs. `codeHash = keccak256(abi.encodePacked(recipient, domain, code))`. A mempool-observed code is useless for any other account/action.

**State**
- `address public owner` (issuer service key; simple onlyOwner)
- `IEAS public immutable eas`
- `bytes32 public immutable schemaUid`
- `mapping(bytes32 => bytes32) public activeCode;   // keccak256(subject, domainHash) => attestation uid`
- `mapping(bytes32 => bool) public consumed;        // uid => used`

**Functions**
- `issueCode(address subject, string calldata domain, bytes32 codeHash, uint64 expiry) external onlyOwner returns (bytes32 uid)` — attests on real EAS (recipient = subject, expirationTime = expiry, data = abi.encode(codeHash, domain)); overwrites any prior active code for the same (subject, domain); emits `CodeIssued`.
- `verifyAndConsume(address subject, string calldata domain, string calldata code) external returns (bool)` — loads attestation from EAS; require: exists, `revocationTime == 0`, `expirationTime > block.timestamp`, `!consumed[uid]`, `keccak256(abi.encodePacked(subject, domain, code)) == storedCodeHash`. Marks consumed, emits `CodeConsumed`. Typed errors: `CodeNotFound`, `CodeExpired`, `CodeInvalid`, `CodeAlreadyUsed`. Callable by anyone; safety comes from domain binding, not caller identity.
- `revokeCode(address subject, string calldata domain) external onlyOwner` — EAS revoke + clear mapping.
- View `isCodeActive(address subject, string calldata domain) external view returns (bool)`.

## 5. Demo-wallet setup runbook (manual, once per demo wallet)

1. Get testnet ETH: GIWA Faucet (0.005/24h) or Nodit faucet (0.01/24h).
2. Open `https://sepolia-playground.giwa.io`, connect wallet (button adds GIWA Sepolia network if missing).
3. Click **Issue Dojang** → sign tx (this is the TESTNET FAUCET Verified Address attestation).
4. Click **Claim VerifiedToken** (24h cooldown), then **Issue UP ID** → pick the demo name.
5. Sanity check via cast:
```bash
cast call 0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9 \
  "isVerified(address,bytes32)(bool)" $WALLET \
  0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678 \
  --rpc-url https://sepolia-rpc.giwa.io
```
Prepare wallets: `alice` (verified + up.id), `bob` (verified + up.id), `mallory` (never touches the Playground — the unverified-recipient warning demo). Record which attester issued (expected: TESTNET FAUCET; verify empirically in step 5 — if the Playground issues under a different attester ID, update `DojangConfig`).

Caution: use throwaway testnet-only keys for all of this; never connect a wallet holding mainnet funds to test dApps.

## 6. Tests (fork GIWA Sepolia: `forge test --fork-url https://sepolia-rpc.giwa.io`)

1. `DojangRead.t.sol`: `isVerified` returns true for a known Playground-verified address (hardcode one of our demo wallets after step 5) with FAUCET attester ID; false for a fresh address; false for a bogus attester ID.
2. `SuhoCodeAttester`: issue → consume happy path; reuse reverts `CodeAlreadyUsed`; wrong code → `CodeInvalid`; warp past expiry → `CodeExpired`; same code different domain → `CodeInvalid`; re-issue same (subject, domain) invalidates the old code.
3. Consumer parity: a toy contract with an `onlyVerified` modifier (per docs pattern) works against the real DojangScroll on fork with configurable attester ID.

## 7. Offchain issuer stub (`issuer/`, phase 2)

Node/TS service holding the SuhoCodeAttester owner key: `POST /arise/request { account, newSignerHash }` → generate 6-digit code → deliver out-of-band (console for now) → `issueCode(...)` with 10-min expiry. Env-var keys, testnet-only, funded from faucet. Until then, a `cast` cheat-sheet in the README covers manual issuance.

## 8. Open item (non-blocking)

Email buidl@giwa.io: ask about third-party attester registration in DojangAttesterBook (so Suho's recovery codes could one day ride the official Verified Code schema) and mainnet timelines. Nothing in this spec waits on the answer.

## 9. Acceptance criteria

- `forge build` clean; all fork tests green.
- One demo wallet fully provisioned via the runbook, `isVerified` returning true via cast.
- `SuhoCodeAttester` deployed to GIWA Sepolia, address + schema UID in `deployments/giwa-sepolia.json`, attestations visible on the explorer.
- No contract hardcodes an attester ID outside `DojangConfig`.
