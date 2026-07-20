# Suho — Ondol Account Layer Spec (v1)

Builds on the attestation layer (SuhoCodeAttester + DojangConfig, already green at 18/18). This spec covers `OndolAccount` (the smart account), `OndolTransferGuard` (verification policy), and `AriseModule` (recovery). Same repo, same `contracts/` Foundry project.

Chain: GIWA Sepolia (91342), RPC `https://sepolia-rpc.giwa.io`. Solidity `^0.8.28`.

## 0. PHASE 0 — Empirical probes (do these FIRST, report results, wait for OK)

Two capabilities decide the architecture. Do not assume either; prove both on the live testnet and report before writing any account code.

**Probe A — EIP-7702 (type-4 transactions).**
Using alice's key from `.env` (never print it): deploy a trivial contract (e.g. one that returns 42), then use cast's 7702 support (`cast wallet sign-auth` + `cast send` with an authorization) to delegate alice's EOA to it. Success = `cast code $ALICE_ADDRESS` returns the `0xef0100…` delegation designator and calling the EOA returns 42. Then clear the delegation (authorize address(0)) and confirm code is empty again — we must know rollback works.

**Probe B — P256VERIFY precompile (RIP-7212) at `0x0000000000000000000000000000000000000100`.**
`cast call` the precompile with a known-good P-256 test vector (use a published RIP-7212 vector). Success = returns 32-byte value 1. Also call with a corrupted vector and confirm empty/0 return.

Report both results and STOP for my OK.
- A ✅ + B ✅ → build the primary design below.
- A ❌ → fallback F1 (standalone account) — flag loudly; this weakens the "keep your up.id" story and I want to know before you build.
- B ❌ → fallback F2 (Solidity P-256 verifier library, e.g. daimo-eth/p256-verifier vendored) — gas is worse but functionality identical.

## 1. Primary design (7702 path)

An EOA (secp256k1 key, e.g. created via Rabby, verified via Playground, holding an up.id) signs a one-time 7702 authorization delegating to the `OndolAccount` implementation. From then on the address is a smart account **at the same address** — Dojang attestation and up.id preserved. Day-to-day operations are authorized by a **passkey** (WebAuthn P-256 signature, verified onchain via the precompile), not the original EOA key. The pitch: the EOA key can go in a drawer; if the passkey device is lost, Arise rotates in a new one.

### 1.1 `OndolAccount.sol`

Storage (remember 7702 rules: storage lives at the EOA's address; use ERC-7201 namespaced storage layout to avoid collisions on future upgrades):
- `bytes32 pubKeyX; bytes32 pubKeyY;` — active passkey P-256 public key
- `uint256 nonce;` — replay protection for passkey-authorized calls
- `address guard;` — OndolTransferGuard (settable only by self-call)
- `address ariseModule;` — sole address permitted to rotate keys
- `bool initialized;`

Functions:
- `initialize(bytes32 x, bytes32 y, address guard_, address arise_)` — callable once; on the 7702 path the first call after delegation, guarded by `require(msg.sender == address(this) || !initialized)` semantics done safely: only the EOA itself (tx.origin == address(this) is NOT the mechanism — on 7702 the EOA can call its own functions directly as msg.sender == its own address via a self-tx; implement init gating simply: if uninitialized, allow only when `msg.sender == address(this)`).
- `execute(Call[] calldata calls, bytes calldata webAuthnSig)` — verifies the WebAuthn assertion over `keccak256(abi.encode(address(this), block.chainid, nonce, calls))` using P256VERIFY; increments nonce; runs each call THROUGH the guard check (§1.2); anyone may relay (gas paid by relayer — our issuer service doubles as relayer for the demo).
  - WebAuthn verification: parse authenticatorData + clientDataJSON per WebAuthn spec; keep it minimal-but-correct (challenge check, type check, user-presence flag). Vendor a small audited-style verifier rather than hand-rolling parsing if simpler (e.g. adapt daimo webauthn verify); cite source in comments.
- `rotatePasskey(bytes32 newX, bytes32 newY)` — `require(msg.sender == ariseModule)`. Emits `PasskeyRotated`.
- `receive()` payable.

### 1.2 `OndolTransferGuard.sol`

Stateless policy contract; account calls `check(Call calldata call) returns (Verdict)` before executing each call.
- Config (immutable/constructor): `IDojangScroll scroll`, `bytes32[] acceptedAttesterIds` (from DojangConfig), `uint256 otpThreshold` (wei), `SuhoCodeAttester codes`.
- Logic for plain ETH transfers and ERC-20 `transfer` calldata (decode selector 0xa9059cbb):
  - recipient verified (any accepted attester) → ALLOW
  - recipient unverified AND value < otpThreshold → ALLOW_WITH_WARNING (event `UnverifiedRecipient(recipient, value)` — the app renders the warning; chain doesn't block small sends)
  - recipient unverified AND value >= otpThreshold → REQUIRE_OTP: the execute call must include a code param; guard calls `codes.verifyAndConsume(account, domain, code)` with `domain = "suho.guard:<account>:<recipient>:<value>"`. Revert `OtpRequired()` if absent/invalid.
- Non-transfer calls (arbitrary calldata to contracts) → ALLOW (v1 scope; note as future policy surface).

### 1.3 `AriseModule.sol`

- Constructor: `SuhoCodeAttester codes`.
- `arise(address account, bytes32 newX, bytes32 newY, string calldata code)`:
  - `domain = string.concat("suho.arise:", toHexString(account), ":", toHexString(keccak256(abi.encode(newX,newY))))`
  - `require(codes.verifyAndConsume(account, domain, code))`
  - `OndolAccount(payable(account)).rotatePasskey(newX, newY)`
  - Emits `Arisen(account, newX, newY)`.
- Callable by anyone (relayable): safety is entirely the purpose-bound single-use code. The lost-device user gets a code from the issuer, a new device passkey, and any relayer can submit.

## 2. Fallback F1 (no 7702): `OndolAccountStandalone`
Same logic as 1.1 but a normally-deployed contract (CREATE2, salt = user identifier). Accept the attestation/up.id gap; add README note that mainnet plan assumes 7702. Only build if Probe A fails.

## 3. Tests (fork: `forge test --fork-url https://sepolia-rpc.giwa.io -vv`)

P-256/WebAuthn test fixtures: generate a P-256 keypair in the test (Foundry vm supports p256 signing via `vm.signP256`), construct WebAuthn-shaped payloads for it. Cases:
1. Probe assertions encoded as tests where possible (precompile vector test always; 7702 delegation test using a fresh vm-generated key on fork — do NOT use alice's real key inside committed test code).
2. execute: happy path (verified recipient), nonce replay reverts, wrong-key sig reverts.
3. Guard: verified → allow; unverified small → allow + event; unverified large without code → `OtpRequired`; with valid code → succeeds and code consumed; code bound to different recipient → reverts.
4. Arise: full rotation flow — old passkey stops working, new one works; reused code reverts; wrong newKey hash in domain reverts.
5. Storage-collision sanity: delegate, initialize, un-delegate, re-delegate — state behaves per 7702 semantics (document findings in comments).

## 4. Deploy script
`DeployOndol.s.sol`: deploys Guard (with DojangConfig values + otpThreshold = 0.01 ether for demo) + AriseModule + OndolAccount implementation; writes addresses to `deployments/giwa-sepolia.json`. Written, not executed, same as before.

## 5. Explicit non-goals (do not build)
No ERC-4337/bundler/EntryPoint integration. No session keys, batching UX, multi-passkey, spending limits beyond the single threshold, token approvals policy, or frontend — those come later or never. If a feature isn't in this file, it doesn't exist.

## 6. Acceptance
- Probe report delivered and OK'd before implementation.
- forge build clean; all fork tests green including full arise rotation.
- alice's real address never hardcoded in tests; real keys only ever read from .env by scripts, never committed, never printed.
- deployments file schema ready; addresses empty until the deploy session.
