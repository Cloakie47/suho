// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OndolTestBase} from "./OndolTestBase.sol";
import {OndolAccountV4} from "../src/OndolAccountV4.sol";
import {OndolProxy} from "../src/OndolProxy.sol";
import {HexStrings} from "../src/libs/HexStrings.sol";
import {Call} from "../src/interfaces/IOndolGuard.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";

/// @dev A V4-plus-marker impl to prove an upgrade took.
contract OndolAccountV4Marked is OndolAccountV4 {
    constructor(SuhoCodeAttester c) OndolAccountV4(c) {}
    function marker() external pure returns (uint256) {
        return 0xB0DE;
    }
}

/// @notice Phase SEC 2.3 fork tests: the OndolAccountV4 email second factor.
///         Serial only: forge test --fork-url https://sepolia-rpc.giwa.io -j 1
///
///         The load-bearing group is 3 (a passkey-only attacker, lock ON, cannot
///         repoint the guard, install a malicious impl, disable the lock, or make
///         a large unverified send). Group 5 proves a locked, passkey-compromised
///         account is still recoverable through Arise. The guardian-side
///         recovery-email-change gate has its own integration test in the guardian
///         phase (it reads sensitiveOpLock() provided here).
contract OndolAccountV4Test is OndolTestBase {
    using HexStrings for address;
    using HexStrings for bytes32;

    OndolAccountV4 internal implV4;
    OndolProxy internal proxyImpl;
    address internal relayer4;
    address internal attacker; // holds the passkey (PASSKEY_PK), NOT the email code

    address internal acct; // a V4 proxy account
    uint256 internal acctPk;

    function setUp() public override {
        super.setUp();
        implV4 = new OndolAccountV4(codes);
        proxyImpl = new OndolProxy();
        relayer4 = makeAddr("v4-relayer");
        attacker = makeAddr("v4-attacker");
        vm.deal(relayer4, 1 ether);
        vm.deal(attacker, 1 ether);
        (acct, acctPk) = _newProxyAccountV4("v4-acct");
        vm.deal(acct, 10 ether);
    }

    // ---- proxy account + execute helpers (mirror the V3 test) ----

    function _initDigest(address a, bytes32 x, bytes32 y, address g, address ar) internal view returns (bytes32) {
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Suho Ondol")),
                keccak256(bytes("2")),
                block.chainid,
                a
            )
        );
        bytes32 sh = keccak256(abi.encode(keccak256("Init(bytes32 x,bytes32 y,address guard,address arise)"), x, y, g, ar));
        return keccak256(abi.encodePacked("\x19\x01", ds, sh));
    }

    function _proxyInitDigest(address a, address impl_) internal view returns (bytes32) {
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Suho Ondol Proxy")),
                keccak256(bytes("1")),
                block.chainid,
                a
            )
        );
        bytes32 sh = keccak256(abi.encode(keccak256("ProxyInit(address implementation)"), impl_));
        return keccak256(abi.encodePacked("\x19\x01", ds, sh));
    }

    function _newProxyAccountV4(string memory label) internal returns (address eoa, uint256 pk) {
        (eoa, pk) = makeAddrAndKey(label);
        vm.signAndAttachDelegation(address(proxyImpl), pk);
        (uint256 x, uint256 y) = vm.publicKeyP256(PASSKEY_PK);
        (uint8 iv, bytes32 ir, bytes32 is_) = vm.sign(pk, _initDigest(eoa, bytes32(x), bytes32(y), address(guard), address(arise)));
        bytes memory initData = abi.encodeCall(
            OndolAccountV4.initializeWithSig, (bytes32(x), bytes32(y), address(guard), address(arise), iv, ir, is_)
        );
        (uint8 pv, bytes32 pr, bytes32 ps) = vm.sign(pk, _proxyInitDigest(eoa, address(implV4)));
        vm.prank(relayer4);
        OndolProxy(payable(eoa)).initialize(address(implV4), initData, pv, pr, ps);
        assertTrue(OndolAccountV4(payable(eoa)).initialized(), "initialized behind proxy");
    }

    function _challengeV4(Call[] memory calls, uint256 maxGas) internal view returns (bytes32) {
        return keccak256(abi.encode(acct, block.chainid, OndolAccountV4(payable(acct)).nonce(), calls, maxGas));
    }

    function _exec(Call[] memory calls, string memory otp, uint256 pk, address submitter) internal {
        bytes memory sig = _signWebAuthn(pk, _challengeV4(calls, 0));
        vm.prank(submitter);
        OndolAccountV4(payable(acct)).execute(calls, otp, 0, sig);
    }

    /// @dev Like _exec but asserts the execute() reverts. The signature (which
    ///      reads nonce() via a view) is computed BEFORE expectRevert so the
    ///      revert assertion lands on the execute() call itself, not the view.
    function _execExpectRevert(Call[] memory calls, string memory otp, uint256 pk, address submitter) internal {
        bytes memory sig = _signWebAuthn(pk, _challengeV4(calls, 0));
        vm.prank(submitter);
        vm.expectRevert();
        OndolAccountV4(payable(acct)).execute(calls, otp, 0, sig);
    }

    function _callTo(address target, uint256 value, bytes memory data) internal pure returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call({target: target, value: value, data: data});
    }

    // ---- code helpers (the test contract is the attester owner) ----

    function _issue(string memory domain, string memory code) internal {
        codes.issueCode(acct, domain, keccak256(abi.encodePacked(acct, domain, code)), uint64(block.timestamp + 10 minutes));
    }

    function _opDomain(string memory op, address param) internal view returns (string memory) {
        return string.concat(
            "suho.op:", op, ":", acct.toHexString(), ":", param.toHexString(), ":",
            bytes32(OndolAccountV4(payable(acct)).sensitiveOpNonce()).toHexString()
        );
    }

    function _disableDomain(string memory kind) internal view returns (string memory) {
        return string.concat(
            "suho.op:", kind, ":", acct.toHexString(), ":",
            bytes32(OndolAccountV4(payable(acct)).sensitiveOpNonce()).toHexString()
        );
    }

    function _sendDomain(address recipient, uint256 value) internal view returns (string memory) {
        return string.concat("suho.send:", acct.toHexString(), ":", recipient.toHexString(), ":", bytes32(value).toHexString());
    }

    function _v4() internal view returns (OndolAccountV4) {
        return OndolAccountV4(payable(acct));
    }

    function _enableControlLock() internal {
        _exec(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.enableSensitiveOpLock, ())), "", PASSKEY_PK, relayer4);
        assertTrue(_v4().sensitiveOpLock(), "control lock engaged");
    }

    function _enableSendLock() internal {
        _exec(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.enableEmailLargeSendLock, ())), "", PASSKEY_PK, relayer4);
        assertTrue(_v4().emailLargeSendLock(), "send lock engaged");
    }

    // =================== 1. storage and migration ===================

    function test_v4_unlocked_behavesLikeV3() public {
        // a normal send works through the real guard
        uint256 before = unverified.balance;
        _exec(_callTo(unverified, 0.001 ether, ""), "", PASSKEY_PK, relayer4);
        assertEq(unverified.balance, before + 0.001 ether, "send landed");
        // setGuard with an empty code works when unlocked (V3 behaviour). Done
        // last: pointing the guard at a codeless address would break a later send.
        address newGuard = makeAddr("guard-2");
        _exec(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.setGuard, (newGuard, ""))), "", PASSKEY_PK, relayer4);
        assertEq(_v4().guard(), newGuard, "guard set with no code when unlocked");
    }

    function test_v4_flagsDefaultFalse() public view {
        assertFalse(_v4().sensitiveOpLock());
        assertFalse(_v4().emailLargeSendLock());
        assertEq(_v4().sensitiveOpNonce(), 0);
    }

    /// Enabling the locks must not corrupt any existing (packed) field.
    function test_v4_storageLayout_noCollision() public {
        address g0 = _v4().guard();
        address a0 = _v4().ariseModule();
        bool init0 = _v4().initialized();
        _enableControlLock();
        _enableSendLock();
        assertEq(_v4().guard(), g0, "guard unchanged after packed writes");
        assertEq(_v4().ariseModule(), a0, "ariseModule unchanged after packed writes");
        assertEq(_v4().initialized(), init0, "initialized unchanged after packed writes");
        assertTrue(_v4().sensitiveOpLock() && _v4().emailLargeSendLock(), "both flags set");
    }

    // =================== 2. enable / disable ===================

    function test_enableLock_passkeyOnly_nonSelfReverts() public {
        vm.prank(attacker);
        vm.expectRevert(OndolAccountV4.NotSelf.selector);
        _v4().enableSensitiveOpLock();
    }

    function test_disableLock_requiresEmailCode_whenLocked() public {
        _enableControlLock();
        _issue(_disableDomain("disablelock"), "111222");
        _exec(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.disableSensitiveOpLock, ("111222"))), "", PASSKEY_PK, relayer4);
        assertFalse(_v4().sensitiveOpLock(), "lock disabled with a valid code");
        assertEq(_v4().sensitiveOpNonce(), 1, "nonce advanced");
    }

    function test_disableLock_wrongCode_reverts() public {
        _enableControlLock();
        _issue(_disableDomain("disablelock"), "111222");
                _execExpectRevert(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.disableSensitiveOpLock, ("999999"))), "", PASSKEY_PK, relayer4);
        assertTrue(_v4().sensitiveOpLock(), "lock stays on after a wrong code");
    }

    // =================== 3. adversarial (passkey-only, lock ON) ===================

    function test_attacker_setGuard_noCode_reverts() public {
        _enableControlLock();
        address g0 = _v4().guard();
        address evil = makeAddr("permissive-guard");
                _execExpectRevert(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.setGuard, (evil, ""))), "", PASSKEY_PK, attacker);
        assertEq(_v4().guard(), g0, "guard unchanged");
    }

    function test_attacker_setGuardZero_noCode_reverts() public {
        _enableControlLock();
        address g0 = _v4().guard();
                _execExpectRevert(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.setGuard, (address(0), ""))), "", PASSKEY_PK, attacker);
        assertEq(_v4().guard(), g0, "guard not zeroed");
    }

    function test_attacker_upgradeTo_noCode_reverts() public {
        _enableControlLock();
        address impl0 = _v4().implementation();
        address evil = makeAddr("malicious-impl");
                _execExpectRevert(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.upgradeTo, (evil, ""))), "", PASSKEY_PK, attacker);
        assertEq(_v4().implementation(), impl0, "impl unchanged");
    }

    function test_attacker_disableLock_noCode_reverts() public {
        _enableControlLock();
                _execExpectRevert(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.disableSensitiveOpLock, (""))), "", PASSKEY_PK, attacker);
        assertTrue(_v4().sensitiveOpLock(), "lock stays on");
    }

    function test_attacker_largeSend_noCode_reverts() public {
        _enableSendLock();
        uint256 before = unverified.balance;
                _execExpectRevert(_callTo(unverified, 0.02 ether, ""), "", PASSKEY_PK, attacker); // large + unverified, no code
        assertEq(unverified.balance, before, "no funds moved");
    }

    function test_attacker_wrongDomainCode_reverts() public {
        _enableControlLock();
        address guardA = makeAddr("guard-A");
        address guardB = makeAddr("guard-B");
        // A valid code for setGuard(guardA) must not authorize setGuard(guardB).
        _issue(_opDomain("setguard", guardA), "424242");
                _execExpectRevert(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.setGuard, (guardB, "424242"))), "", PASSKEY_PK, attacker);
        assertTrue(_v4().guard() != guardB, "guardB not installed");
    }

    function test_attacker_staleNonceCode_reverts() public {
        _enableControlLock();
        address guardA = makeAddr("guard-A");
        address guardB = makeAddr("guard-B");
        // Consume one op (nonce 0 -> 1) with a valid code.
        _issue(_opDomain("setguard", guardA), "111111");
        _exec(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.setGuard, (guardA, "111111"))), "", PASSKEY_PK, relayer4);
        assertEq(_v4().guard(), guardA);
        // A code minted for the OLD nonce (0) is now stale (current nonce is 1).
        // Re-issuing at nonce 0 domain then trying to use it must fail.
        string memory staleDomain = string.concat(
            "suho.op:setguard:", acct.toHexString(), ":", guardB.toHexString(), ":", bytes32(uint256(0)).toHexString()
        );
        codes.issueCode(acct, staleDomain, keccak256(abi.encodePacked(acct, staleDomain, "222222")), uint64(block.timestamp + 10 minutes));
                _execExpectRevert(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.setGuard, (guardB, "222222"))), "", PASSKEY_PK, attacker);
        assertEq(_v4().guard(), guardA, "stale-nonce code rejected");
    }

    function test_attacker_replayConsumedCode_reverts() public {
        _enableControlLock();
        address guardA = makeAddr("guard-A");
        _issue(_opDomain("setguard", guardA), "333333");
        _exec(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.setGuard, (guardA, "333333"))), "", PASSKEY_PK, relayer4);
        // Replaying the same code (now consumed + nonce advanced) must fail.
                _execExpectRevert(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.setGuard, (guardA, "333333"))), "", PASSKEY_PK, attacker);
    }

    // =================== 4. positive (both factors) ===================

    function test_setGuard_withEmailCode_succeeds() public {
        _enableControlLock();
        address newGuard = makeAddr("guard-new");
        _issue(_opDomain("setguard", newGuard), "121212");
        _exec(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.setGuard, (newGuard, "121212"))), "", PASSKEY_PK, relayer4);
        assertEq(_v4().guard(), newGuard, "guard set with passkey + email code");
        assertEq(_v4().sensitiveOpNonce(), 1, "nonce advanced");
    }

    function test_upgradeTo_withEmailCode_succeeds() public {
        _enableControlLock();
        OndolAccountV4Marked marked = new OndolAccountV4Marked(codes);
        _issue(_opDomain("upgrade", address(marked)), "565656");
        _exec(_callTo(acct, 0, abi.encodeCall(OndolAccountV4.upgradeTo, (address(marked), "565656"))), "", PASSKEY_PK, relayer4);
        assertEq(_v4().implementation(), address(marked), "impl upgraded");
        assertEq(OndolAccountV4Marked(payable(acct)).marker(), 0xB0DE, "runs on new code");
    }

    function test_largeSend_withEmailCode_succeeds() public {
        _enableSendLock();
        uint256 amount = 0.02 ether; // large + unverified
        uint256 before = unverified.balance;
        _issue(_sendDomain(unverified, amount), "778899");
        _exec(_callTo(unverified, amount, ""), "778899", PASSKEY_PK, relayer4);
        assertEq(unverified.balance, before + amount, "large unverified send completed with the email code");
    }

    function test_sendCode_boundToRecipientAndValue() public {
        _enableSendLock();
        uint256 amount = 0.02 ether;
        _issue(_sendDomain(unverified, amount), "778899");
        // A code for (unverified, amount) must not authorize a different value.
                _execExpectRevert(_callTo(unverified, 0.03 ether, ""), "778899", PASSKEY_PK, attacker);
    }

    // =================== 5. recovery survives a locked account ===================

    function test_arise_stillRotates_whenLocked() public {
        _enableControlLock();
        _enableSendLock();
        (uint256 nx, uint256 ny) = vm.publicKeyP256(PASSKEY2_PK);
        // Issue a recovery code the AriseModule domain expects.
        string memory domain = string.concat(
            "suho.arise:", acct.toHexString(), ":", keccak256(abi.encode(bytes32(nx), bytes32(ny))).toHexString()
        );
        codes.issueCode(acct, domain, keccak256(abi.encodePacked(acct, domain, "654321")), uint64(block.timestamp + 10 minutes));
        arise.arise(acct, bytes32(nx), bytes32(ny), "654321");
        (bytes32 x2, bytes32 y2) = _v4().passkey();
        assertEq(x2, bytes32(nx), "key rotated despite the locks");
        assertEq(y2, bytes32(ny), "key rotated despite the locks");
    }

    function test_rotatePasskey_notAriseModule_reverts() public {
        _enableControlLock();
        vm.prank(attacker);
        vm.expectRevert(OndolAccountV4.NotAriseModule.selector);
        _v4().rotatePasskey(bytes32(uint256(1)), bytes32(uint256(2)));
    }

    // =================== 6. G2 ETH-only scope ===================

    function test_largeErc20Send_locked_reverts() public {
        _enableSendLock();
        // A large unverified ERC-20 transfer reverts until the token decode is audited.
        bytes memory erc20 = abi.encodeWithSelector(bytes4(0xa9059cbb), unverified, uint256(0.02 ether));
                _execExpectRevert(_callTo(makeAddr("some-token"), 0, erc20), "", PASSKEY_PK, relayer4);
    }

    function test_smallUnverifiedSend_locked_noCodeNeeded() public {
        _enableSendLock();
        uint256 before = unverified.balance;
        // Below the threshold: allowed with no email code even when the lock is on.
        _exec(_callTo(unverified, 0.001 ether, ""), "", PASSKEY_PK, relayer4);
        assertEq(unverified.balance, before + 0.001 ether, "small send passes without a code");
    }
}
