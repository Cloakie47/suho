// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OndolTestBase} from "./OndolTestBase.sol";
import {OndolAccountV2} from "../src/OndolAccountV2.sol";
import {OndolAccountV3} from "../src/OndolAccountV3.sol";
import {OndolProxy} from "../src/OndolProxy.sol";
import {Call} from "../src/interfaces/IOndolGuard.sol";

/// @dev A V3-plus-marker implementation used only to prove an upgrade took and
///      the account still works on the new code. Inherits all of V3, adds a
///      marker readable through the proxy.
contract OndolAccountV3Marked is OndolAccountV3 {
    function marker() external pure returns (uint256) {
        return 0xC0DE;
    }
}

/// @notice Phase G fork tests. Serial runs only (the public RPC rate-limits
///         parallel suites): forge test --fork-url https://sepolia-rpc.giwa.io -j 1
///
///         Covers the eight acceptance cases: capped reimbursement, cap
///         enforcement under a hostile third-party relayer at 100x gas price, the
///         signed-cap binding, the sponsored path, the doomed-tx refusal, a
///         proxy upgrade authorized by the passkey, upgrade access control, and
///         no regression for legacy V2 accounts.
contract OndolAccountV3Test is OndolTestBase {
    OndolAccountV3 internal implV3;
    OndolProxy internal proxyImpl;

    address internal relayer3; // the account's normal relayer
    address internal hostile; // an unrelated third party

    address internal proxyAcct; // a proxy-fronted, V3-initialized account
    uint256 internal proxyAcctPk;

    function setUp() public override {
        super.setUp(); // full stack: codes, guard, arise
        implV3 = new OndolAccountV3();
        proxyImpl = new OndolProxy();
        relayer3 = makeAddr("v3-relayer");
        hostile = makeAddr("hostile-relayer");
        vm.deal(relayer3, 1 ether);
        vm.deal(hostile, 1 ether);

        (proxyAcct, proxyAcctPk) = _newProxyAccount("v3-proxy-acct");
        vm.deal(proxyAcct, 10 ether);
    }

    // ---- EIP-712 helpers (mirror the contracts byte for byte) ----

    function _initDigest(address account_, bytes32 x, bytes32 y, address guard_, address arise_)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Suho Ondol")),
                keccak256(bytes("2")),
                block.chainid,
                account_
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Init(bytes32 x,bytes32 y,address guard,address arise)"), x, y, guard_, arise_)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _proxyInitDigest(address account_, address impl_) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Suho Ondol Proxy")),
                keccak256(bytes("1")),
                block.chainid,
                account_
            )
        );
        bytes32 structHash = keccak256(abi.encode(keccak256("ProxyInit(address implementation)"), impl_));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _passkeyXY() internal pure returns (bytes32 x, bytes32 y) {
        (uint256 px, uint256 py) = vm.publicKeyP256(PASSKEY_PK);
        return (bytes32(px), bytes32(py));
    }

    /// @dev Fresh EOA -> delegate to the proxy -> proxy.initialize installs V3
    ///      and runs V3.initializeWithSig. Two EOA signatures: one binding the
    ///      implementation (proxy), one binding the passkey (impl).
    function _newProxyAccount(string memory label) internal returns (address eoa, uint256 pk) {
        (eoa, pk) = makeAddrAndKey(label);
        vm.signAndAttachDelegation(address(proxyImpl), pk);
        assertEq(eoa.balance, 0, "onboarding EOA never needs gas");

        (bytes32 x, bytes32 y) = _passkeyXY();
        (uint8 iv, bytes32 ir, bytes32 is_) =
            vm.sign(pk, _initDigest(eoa, x, y, address(guard), address(arise)));
        bytes memory initData = abi.encodeCall(
            OndolAccountV3.initializeWithSig, (x, y, address(guard), address(arise), iv, ir, is_)
        );
        (uint8 pv, bytes32 pr, bytes32 ps) = vm.sign(pk, _proxyInitDigest(eoa, address(implV3)));

        vm.prank(relayer3);
        OndolProxy(payable(eoa)).initialize(address(implV3), initData, pv, pr, ps);

        assertTrue(OndolAccountV3(payable(eoa)).initialized(), "initialized behind proxy");
        assertEq(OndolAccountV3(payable(eoa)).implementation(), address(implV3), "impl slot set");
    }

    function _challengeV3(address acct, Call[] memory calls, uint256 maxGasPayment)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(acct, block.chainid, OndolAccountV3(payable(acct)).nonce(), calls, maxGasPayment)
        );
    }

    function _executeV3(
        address acct,
        Call[] memory calls,
        string memory otp,
        uint256 maxGasPayment,
        uint256 pk,
        address submitter
    ) internal {
        bytes memory sig = _signWebAuthn(pk, _challengeV3(acct, calls, maxGasPayment));
        vm.prank(submitter);
        OndolAccountV3(payable(acct)).execute(calls, otp, maxGasPayment, sig);
    }

    // ---- 1. reimbursement happy path ----

    /// The relayer is reimbursed the real metered cost; the account drops by
    /// transfer + payment; the cap is not binding (payment < cap). (The test EVM
    /// does not charge the pranked relayer for gas, so "made whole" is shown by
    /// the reimbursement transfer, not a net-zero balance.)
    function test_1_reimbursement_happyPath() public {
        vm.txGasPrice(1 gwei);
        uint256 maxGas = 0.001 ether;
        uint256 relBefore = relayer3.balance;
        uint256 acctBefore = proxyAcct.balance;
        uint256 recBefore = VERIFIED_RECIPIENT.balance;

        _executeV3(proxyAcct, _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether), "", maxGas, PASSKEY_PK, relayer3);

        uint256 payment = relayer3.balance - relBefore;
        assertEq(VERIFIED_RECIPIENT.balance, recBefore + 0.1 ether, "transfer landed");
        assertGt(payment, 0, "relayer reimbursed");
        assertLt(payment, maxGas, "real cost, under the cap");
        assertEq(proxyAcct.balance, acctBefore - 0.1 ether - payment, "account debited transfer + payment");
    }

    // ---- 2. cap enforced under a hostile third-party relayer at 100x ----

    /// A validly signed batch is taken by an UNRELATED third party and submitted
    /// at 100x gas price. The payment is exactly the signed cap, never more, and
    /// the excess gas is the hostile relayer's own loss.
    function test_2_hostileRelayer_100xGasPrice_paysExactlyCap() public {
        uint256 cap = 0.0002 ether;
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether);
        bytes memory sig = _signWebAuthn(PASSKEY_PK, _challengeV3(proxyAcct, calls, cap));

        vm.txGasPrice(100 gwei); // absurd, hostile
        uint256 hostBefore = hostile.balance;
        uint256 acctBefore = proxyAcct.balance;

        vm.prank(hostile); // a third party, not relayer3
        OndolAccountV3(payable(proxyAcct)).execute(calls, "", cap, sig);

        assertEq(hostile.balance - hostBefore, cap, "payment == cap exactly, no more");
        assertEq(proxyAcct.balance, acctBefore - 0.1 ether - cap, "account paid transfer + cap only");
    }

    // ---- 3. the signature binds the cap ----

    /// Signed for cap X, submitted claiming Y > X: the challenge differs, so the
    /// passkey signature does not verify.
    function test_3_signatureBindsCap_higherClaimReverts() public {
        uint256 signedCap = 0.0002 ether;
        uint256 claimedCap = 0.001 ether; // Y > X
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether);
        bytes memory sig = _signWebAuthn(PASSKEY_PK, _challengeV3(proxyAcct, calls, signedCap));

        vm.prank(hostile);
        vm.expectRevert(OndolAccountV3.InvalidPasskeySignature.selector);
        OndolAccountV3(payable(proxyAcct)).execute(calls, "", claimedCap, sig);
    }

    // ---- 4. sponsored path ----

    /// maxGasPayment == 0 pays nothing even at a high gas price; the relayer eats
    /// the gas and the account is debited only the transfer. Identical to V2.
    function test_4_sponsored_zeroCap_paysNothing() public {
        vm.txGasPrice(100 gwei);
        uint256 relBefore = relayer3.balance;
        uint256 acctBefore = proxyAcct.balance;

        _executeV3(proxyAcct, _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether), "", 0, PASSKEY_PK, relayer3);

        assertEq(relayer3.balance, relBefore, "sponsored: no reimbursement");
        assertEq(proxyAcct.balance, acctBefore - 0.1 ether, "sponsored: only the transfer left the account");
    }

    // ---- 5. insufficient balance refuses before executing ----

    /// Balance below the cap reverts CannotCoverGas up front; no call runs, so the
    /// recipient balance is unchanged and the relayer never burns gas on it.
    function test_5_insufficientBalance_revertsWithoutExecuting() public {
        (address poor,) = _newProxyAccount("poor-acct");
        vm.deal(poor, 0.0001 ether); // below the cap
        uint256 cap = 0.001 ether;
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.00005 ether);
        bytes memory sig = _signWebAuthn(PASSKEY_PK, _challengeV3(poor, calls, cap));

        uint256 recBefore = VERIFIED_RECIPIENT.balance;
        vm.prank(relayer3);
        vm.expectRevert(OndolAccountV3.CannotCoverGas.selector);
        OndolAccountV3(payable(poor)).execute(calls, "", cap, sig);

        assertEq(VERIFIED_RECIPIENT.balance, recBefore, "no call executed");
        assertEq(OndolAccountV3(payable(poor)).nonce(), 0, "nonce untouched");
    }

    // ---- 6. proxy upgrade by the passkey, state survives, new impl live ----

    function test_6_proxyUpgrade_passkeySigned_stateSurvives() public {
        // a prior execute so there is state (nonce) to preserve across the upgrade
        _executeV3(proxyAcct, _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether), "", 0, PASSKEY_PK, relayer3);
        uint256 nonceBefore = OndolAccountV3(payable(proxyAcct)).nonce();
        (bytes32 pxBefore,) = OndolAccountV3(payable(proxyAcct)).passkey();

        OndolAccountV3Marked marked = new OndolAccountV3Marked();
        Call[] memory upgrade = new Call[](1);
        upgrade[0] = Call({
            target: proxyAcct,
            value: 0,
            data: abi.encodeCall(OndolAccountV3.upgradeTo, (address(marked)))
        });
        _executeV3(proxyAcct, upgrade, "", 0, PASSKEY_PK, relayer3);

        // new impl is live through the proxy
        assertEq(OndolAccountV3Marked(payable(proxyAcct)).marker(), 0xC0DE, "new impl live");
        assertEq(OndolAccountV3(payable(proxyAcct)).implementation(), address(marked), "impl pointer moved");

        // state survived (nonce bumped once by the upgrade execute, passkey intact)
        assertEq(OndolAccountV3(payable(proxyAcct)).nonce(), nonceBefore + 1, "nonce survived");
        (bytes32 pxAfter,) = OndolAccountV3(payable(proxyAcct)).passkey();
        assertEq(pxAfter, pxBefore, "passkey survived");

        // and it still executes on the upgraded implementation
        uint256 recBefore = VERIFIED_RECIPIENT.balance;
        _executeV3(proxyAcct, _ethTransfer(VERIFIED_RECIPIENT, 0.05 ether), "", 0, PASSKEY_PK, relayer3);
        assertEq(VERIFIED_RECIPIENT.balance, recBefore + 0.05 ether, "executes on new impl");
    }

    // ---- 7. upgradeTo is self-only ----

    /// A direct call from anyone but the account itself reverts NotSelf; the impl
    /// pointer is unchanged.
    function test_7_upgradeTo_onlySelf() public {
        OndolAccountV3Marked marked = new OndolAccountV3Marked();
        vm.prank(hostile);
        vm.expectRevert(OndolAccountV3.NotSelf.selector);
        OndolAccountV3(payable(proxyAcct)).upgradeTo(address(marked));
        assertEq(OndolAccountV3(payable(proxyAcct)).implementation(), address(implV3), "impl unchanged");
    }

    // ---- 8. legacy V2 account: no regression ----

    /// A V2-delegated account (no proxy, old 3-arg execute) still initializes and
    /// executes exactly as before.
    function test_8_legacyV2_stillWorks() public {
        OndolAccountV2 implV2 = new OndolAccountV2();
        (address v2acct, uint256 v2pk) = makeAddrAndKey("legacy-v2");
        vm.signAndAttachDelegation(address(implV2), v2pk);

        (bytes32 x, bytes32 y) = _passkeyXY();
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(v2pk, _initDigest(v2acct, x, y, address(guard), address(arise)));
        vm.prank(relayer3);
        OndolAccountV2(payable(v2acct)).initializeWithSig(x, y, address(guard), address(arise), v, r, s);

        vm.deal(v2acct, 1 ether);
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether);
        bytes32 ch = keccak256(abi.encode(v2acct, block.chainid, uint256(0), calls));
        bytes memory sig = _signWebAuthn(PASSKEY_PK, ch);

        uint256 recBefore = VERIFIED_RECIPIENT.balance;
        vm.prank(relayer3);
        OndolAccountV2(payable(v2acct)).execute(calls, "", sig);

        assertEq(VERIFIED_RECIPIENT.balance, recBefore + 0.1 ether, "legacy V2 transfer landed");
        assertEq(OndolAccountV2(payable(v2acct)).nonce(), 1, "legacy V2 nonce advanced");
    }
}
