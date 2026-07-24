# Suho — Phase G: Sustainable Relaying and Upgradeable Accounts

Goal: Suho becomes a product strangers can use without draining the operator, and accounts can be fixed after they ship. Two contract changes plus operational hardening. This is the phase that makes public testing honest.

## G0. Probes (report, then STOP for OK)

**Probe F — L1 fee oracle.** GIWA is OP Stack. Check the GasPriceOracle predeploy at `0x420000000000000000000000000000000000000F`: does `getL1FeeUpperBound(uint256)` exist (Fjord+) and return sane values on GIWA Sepolia? Also read `getL1Fee(bytes)`. Report gas cost of calling each. If neither is usable, we fold the L1 portion into a fixed overhead constant instead.

**Probe G — real cost baseline.** From recent live executes, report: L2 gas used, tx.gasprice, L1 fee, total ETH cost for (a) a simple guarded send, (b) a card update batch, (c) an arise. These numbers set the default `maxGasPayment` the app proposes.

## G1. OndolProxy — the upgradeable 7702 target (do this first, everything else builds on it)

**Why:** an onboarded user's bootstrap EOA key is destroyed, so their 7702 delegation is immutable forever. Delegating to a proxy instead of an implementation restores an upgrade path that the passkey controls.

- `OndolProxy`: minimal contract. Reads implementation from ERC-1967 slot (`0x360894...bbc`), `fallback()` delegatecalls to it. Nothing else. This is what accounts delegate to from now on.
- Implementation slot is written at initialization (the proxy's initializer sets impl + calls into it), and thereafter only by `upgradeTo(address)` **on the implementation**, gated `require(msg.sender == address(this))` so it can only be reached through a passkey-signed `execute()` batch. No admin, no guardian, no owner. The user's passkey is the only upgrade authority.
- Storage: ERC-7201 namespace unchanged from V2, so a proxy-fronted account's state layout matches. The impl slot is ERC-1967, deliberately outside our namespace.
- Guardian and app must treat both delegation shapes as valid Ondol accounts: designator → proxy (new) or → V2/V1 impl (legacy). `/status` reports which, and whether the account is upgradeable.

**Migration reality, document it plainly in docs and README:**
- Accounts delegated straight to V1/V2 with a live EOA key (alice): can re-delegate to the proxy. Do it.
- Accounts from Phase O onboarding (key destroyed): permanently pinned to V2. They keep working. They cannot upgrade. Suho shows them a small note: "This account was created before upgradeable accounts. It works, but it cannot receive future upgrades. Move funds to a new account when convenient."
- Everything created from Phase G onward: proxy-fronted, upgradeable by its own passkey.

## G2. OndolAccountV3 — capped gas reimbursement

New signature: `execute(Call[] calls, uint256 maxGasPayment, bytes webAuthnSig)`.

- **The signed digest now includes `maxGasPayment`.** This is the security core: without a signed cap, a relayer could inflate gas or gas price and drain the account. The user authorizes at most N wei of reimbursement, and the contract pays `min(actualCost, maxGasPayment)`.
- Metering: `gasStart = gasleft()` at entry; after calls, `gasUsed = gasStart - gasleft() + FIXED_OVERHEAD` where FIXED_OVERHEAD (immutable constant, tuned from Probe G) covers intrinsic gas, calldata, and the payment transfer itself.
- Cost: `l2 = gasUsed * tx.gasprice`; `l1 = ` oracle upper bound if Probe F says it is available and cheap, else folded into FIXED_OVERHEAD. `payment = min(l2 + l1, maxGasPayment)`.
- Pay `msg.sender` (whoever paid the gas gets reimbursed; that is correct even if a third party relays).
- `maxGasPayment == 0` means sponsored: no reimbursement, identical to V2 behavior. Onboarding and any operator-sponsored flow use this path.
- Insufficient balance to cover payment → revert `CannotCoverGas()` before executing anything (check balance against maxGasPayment up front), so the relayer never burns gas on a doomed transaction.
- Everything else (WebAuthn verification, guard hook, rotatePasskey, initializeWithSig, low-s on both curves) carries over from V2 unchanged.
- Add `upgradeTo(address)` per G1.

**Fork tests (serial runs; the public RPC rate-limits parallel suites):**
1. Reimbursement happy path: relayer balance before/after shows it was made close to whole; account balance drops by transfer + payment.
2. Cap enforced: relayer submits at an absurd gas price; payment is exactly maxGasPayment, not more.
3. Signature binds the cap: a batch signed for maxGasPayment=X, submitted claiming Y>X, reverts InvalidPasskeySignature.
4. Sponsored path: maxGasPayment=0 pays nothing, relayer eats gas, execution succeeds.
5. Insufficient balance reverts CannotCoverGas without executing the calls (assert recipient balance unchanged).
6. Proxy: initialize through proxy, execute, then passkey-signed upgradeTo a V3-plus-marker impl, confirm state survives and the new impl is live.
7. upgradeTo cannot be called by anyone but the account itself (direct call from EOA/relayer reverts).
8. Legacy: a V2-delegated account still works against the current guardian (no regression for pinned accounts).

## G3. Guardian preflight and honest refusal

- Before relaying: `eth_call` simulate the exact transaction. On revert, map the typed error and refuse with the human sentence, spending nothing.
- Compute a recommended `maxGasPayment` server-side (current gas price + L1 estimate + 25% margin) and return it to the app; the app shows it to the user before the passkey prompt ("Network fee: about 0.0000003 ETH, paid from your balance"), and the passkey signs that number.
- Refuse to relay when the account cannot cover the fee, with a sentence that says what to do: "Your account needs a little more ETH to cover the network fee."

## G4. Operating in public

- **Relayer floor:** guardian reads its own balance. Below a configured floor, sponsored onboarding is disabled (reimbursed operations continue), `/status` reports degraded, and the app shows the warn banner: "New account creation is paused. The demo relayer needs a top-up." Never fail silently.
- **Onboarding abuse:** sponsored onboarding is the only free operation, so cap it: per-IP limit (existing), plus a global daily cap from env, plus a simple duplicate-passkey check (same credential id cannot onboard twice). Log counts, no PII.
- **Metrics endpoint** `/health`: relayer balance, sponsored onboardings today, relays served, last error, chain head lag. Public, no secrets, so you and the GIWA team can see the service is alive.
- **Docs page "Costs and limits":** who pays for what, the reimbursement model, the sponsored onboarding cap, and the current relayer address so anyone can top it up or audit spend.

## G5. Deployment (carry over from the deploy prep already requested)

Static (landing, docs, app) to Vercel; guardian to Railway with env vars for keys, CORS allowlist, floors and caps. Configurable URLs everywhere. Document both in a docs "Deploying" page. Never commit .env; Railway variables only.

## Acceptance

- Fork tests all green, serial.
- Proxy-fronted account created, upgraded by its own passkey, and still working afterward on live GIWA Sepolia.
- A real send from a proxy account leaves the relayer's balance within a few percent of where it started, verified on chain.
- Sponsored onboarding still works for a brand new user with zero balance.
- Relayer floor demonstrated: set the floor above current balance, confirm the app shows the paused state and the guardian refuses cleanly, then restore.
- Legacy V2 accounts (including alice's onboarded siblings) still send successfully.
- Docs updated: Costs and limits, the pinned-account explanation, Deploying.
