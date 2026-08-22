// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OndolTestBase} from "./OndolTestBase.sol";
import {OndolSpendingGuard} from "../src/OndolSpendingGuard.sol";
import {OndolAccountV4} from "../src/OndolAccountV4.sol";
import {OndolAccountV5} from "../src/OndolAccountV5.sol";
import {OndolProxy} from "../src/OndolProxy.sol";
import {HexStrings} from "../src/libs/HexStrings.sol";
import {Call} from "../src/interfaces/IOndolGuard.sol";

/// @notice Bank-model spending guard fork tests.
///         Serial only: forge test --fork-url https://sepolia-rpc.giwa.io -j 1
///
///         Guard-level tests prank AS the account and call the guard directly (the
///         guard keys everything on msg.sender = the account; the "thief" is simply
///         a caller without the email code). Account-integration tests (19-21 + the
///         two execute sends) drive a real V5 proxy account with sensitiveOpLock ON
///         pointed at this guard — Decision A — to prove the account-side bypasses
///         are closed and the account threads the code through to the guard.
contract OndolSpendingGuardTest is OndolTestBase {
    using HexStrings for address;
    using HexStrings for bytes32;

    OndolSpendingGuard internal sguard;
    uint128 internal constant PER_TX = 0.01 ether;
    uint128 internal constant DAILY = 0.02 ether;
    uint128 internal constant UNLIMITED = type(uint128).max;

    address internal acctA; // a mock account address; we prank as it to call the guard
    address internal acctB;
    address internal rcpt;
    address internal tokenAddr;

    // account-integration (Decision A)
    OndolAccountV5 internal implV5;
    OndolProxy internal proxyImpl;
    address internal bankAcct;
    uint256 internal bankPk;
    address internal thief;

    function setUp() public override {
        super.setUp(); // codes (attester; this test is the issuer), arise, VERIFIED_RECIPIENT
        sguard = new OndolSpendingGuard(codes, PER_TX, DAILY);
        acctA = makeAddr("bank-acct-A");
        acctB = makeAddr("bank-acct-B");
        rcpt = makeAddr("recipient");
        tokenAddr = makeAddr("some-token");

        implV5 = new OndolAccountV5(codes);
        proxyImpl = new OndolProxy();
        thief = makeAddr("thief");
        vm.deal(thief, 1 ether);
        _setUpBankAccount();
    }

    // =================== guard-level helpers ===================

    function _eth(address to, uint256 v) internal pure returns (Call memory c) {
        c = Call({target: to, value: v, data: ""});
    }

    function _erc20Data(address to, uint256 amt) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(bytes4(0xa9059cbb), to, amt);
    }

    function _check(address account, Call memory c, string memory code) internal {
        vm.prank(account);
        sguard.check(c, code);
    }

    function _checkReverts(address account, Call memory c, string memory code) internal {
        vm.prank(account);
        vm.expectRevert();
        sguard.check(c, code);
    }

    function _issue(address subject, string memory domain, string memory code) internal {
        codes.issueCode(
            subject, domain, keccak256(abi.encodePacked(subject, domain, code)), uint64(block.timestamp + 10 minutes)
        );
    }

    function _ethDomain(address account, address recipient, uint256 value, uint64 nonce)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            "suho.spend:",
            account.toHexString(),
            ":",
            recipient.toHexString(),
            ":",
            bytes32(value).toHexString(),
            ":",
            bytes32(uint256(nonce)).toHexString()
        );
    }

    function _tokenDomain(address account, address token, bytes memory data, uint64 nonce)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            "suho.token:",
            account.toHexString(),
            ":",
            token.toHexString(),
            ":",
            keccak256(data).toHexString(),
            ":",
            bytes32(uint256(nonce)).toHexString()
        );
    }

    function _limitDomain(address account, uint128 perTx, uint128 daily, uint64 nonce)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            "suho.limit:",
            account.toHexString(),
            ":",
            bytes32(uint256(perTx)).toHexString(),
            ":",
            bytes32(uint256(daily)).toHexString(),
            ":",
            bytes32(uint256(nonce)).toHexString()
        );
    }

    // =================== 1. enforcement (deterministic) ===================

    function test_inLimit_anyRecipient_oneTap_noCode() public {
        // Identical behaviour to a verified vs an unverified recipient; no recipient gating.
        _check(acctA, _eth(unverified, 0.005 ether), "");
        _check(acctA, _eth(VERIFIED_RECIPIENT, 0.005 ether), "");
        assertEq(sguard.spentToday(acctA), 0.01 ether, "both in-limit sends recorded, no code");
    }

    function test_overPerTx_withoutCode_reverts() public {
        _checkReverts(acctA, _eth(rcpt, 0.015 ether), ""); // > perTx 0.01, no code
    }

    function test_overPerTx_withCode_succeeds() public {
        uint64 n = sguard.opNonce(acctA);
        _issue(acctA, _ethDomain(acctA, rcpt, 0.015 ether, n), "111222");
        _check(acctA, _eth(rcpt, 0.015 ether), "111222");
        assertEq(sguard.opNonce(acctA), n + 1, "nonce advanced");
        assertEq(sguard.spentToday(acctA), 0.015 ether, "over-limit amount recorded");
    }

    function test_overDaily_cumulative_withoutCode_reverts() public {
        _check(acctA, _eth(rcpt, 0.008 ether), ""); // spent 0.008
        _check(acctA, _eth(rcpt, 0.008 ether), ""); // spent 0.016
        _checkReverts(acctA, _eth(rcpt, 0.008 ether), ""); // 0.024 > daily 0.02
    }

    function test_defaultsApplyToFreshAccount() public view {
        (uint128 p, uint128 d) = sguard.limitsOf(acctA);
        assertEq(p, PER_TX);
        assertEq(d, DAILY);
    }

    function test_window_resetsAfter24h() public {
        _check(acctA, _eth(rcpt, 0.008 ether), "");
        _check(acctA, _eth(rcpt, 0.008 ether), ""); // spent 0.016
        _checkReverts(acctA, _eth(rcpt, 0.008 ether), ""); // over daily
        vm.warp(block.timestamp + 1 days + 1);
        _check(acctA, _eth(rcpt, 0.008 ether), ""); // window reset — allowed
        assertEq(sguard.spentToday(acctA), 0.008 ether, "daily counter reset");
    }

    function test_overLimitAuthorized_amountCountsTowardDaily() public {
        uint64 n = sguard.opNonce(acctA);
        _issue(acctA, _ethDomain(acctA, rcpt, 0.015 ether, n), "333444");
        _check(acctA, _eth(rcpt, 0.015 ether), "333444"); // authorized; spent 0.015
        // A small in-limit send would now cross daily → needs a code (no free draining).
        _checkReverts(acctA, _eth(rcpt, 0.008 ether), "");
    }

    function test_nonValueCall_passesUntouched() public {
        Call memory c = Call({target: rcpt, value: 0, data: hex"12345678"}); // unknown selector, no value
        _check(acctA, c, "");
        assertEq(sguard.spentToday(acctA), 0, "no spend recorded for a value-0 call");
    }

    // =================== 2. code binding / replay ===================

    function test_sendCode_boundToRecipientAndValue() public {
        uint64 n = sguard.opNonce(acctA);
        _issue(acctA, _ethDomain(acctA, rcpt, 0.015 ether, n), "555666");
        // A code for (rcpt, 0.015) must not authorize a different value or recipient.
        _checkReverts(acctA, _eth(rcpt, 0.016 ether), "555666");
        _checkReverts(acctA, _eth(makeAddr("other"), 0.015 ether), "555666");
        // The exact payment works.
        _check(acctA, _eth(rcpt, 0.015 ether), "555666");
    }

    function test_sendCode_replay_reverts() public {
        uint64 n = sguard.opNonce(acctA);
        _issue(acctA, _ethDomain(acctA, rcpt, 0.015 ether, n), "777888");
        _check(acctA, _eth(rcpt, 0.015 ether), "777888"); // consumed, nonce++
        _checkReverts(acctA, _eth(rcpt, 0.015 ether), "777888"); // replay rejected
    }

    function test_sendCode_staleNonce_reverts() public {
        uint64 n0 = sguard.opNonce(acctA);
        _issue(acctA, _ethDomain(acctA, rcpt, 0.015 ether, n0), "999000");
        _check(acctA, _eth(rcpt, 0.015 ether), "999000"); // nonce n0 -> n0+1
        // A code minted at the OLD nonce for a new send is stale (current nonce advanced).
        _issue(acctA, _ethDomain(acctA, rcpt, 0.016 ether, n0), "aaabbb");
        _checkReverts(acctA, _eth(rcpt, 0.016 ether), "aaabbb");
    }

    // =================== 3. limit changes (locked) ===================

    function test_lowerLimits_noCode() public {
        vm.prank(acctA);
        sguard.setLimits(0.005 ether, 0.01 ether, ""); // both below default — strengthening
        (uint128 p, uint128 d) = sguard.limitsOf(acctA);
        assertEq(p, 0.005 ether);
        assertEq(d, 0.01 ether);
    }

    function test_raiseLimits_withoutCode_reverts() public {
        vm.prank(acctA);
        vm.expectRevert();
        sguard.setLimits(0.05 ether, 0.1 ether, ""); // raise, no code
    }

    function test_raiseLimits_withCode_succeeds() public {
        uint64 n = sguard.opNonce(acctA);
        _issue(acctA, _limitDomain(acctA, 0.05 ether, 0.1 ether, n), "cccddd");
        vm.prank(acctA);
        sguard.setLimits(0.05 ether, 0.1 ether, "cccddd");
        (uint128 p, uint128 d) = sguard.limitsOf(acctA);
        assertEq(p, 0.05 ether);
        assertEq(d, 0.1 ether);
        assertEq(sguard.opNonce(acctA), n + 1);
    }

    function test_disableLimits_isRaise_requiresCode() public {
        vm.prank(acctA);
        vm.expectRevert();
        sguard.setLimits(UNLIMITED, UNLIMITED, ""); // disabling = raise → needs code
        uint64 n = sguard.opNonce(acctA);
        _issue(acctA, _limitDomain(acctA, UNLIMITED, UNLIMITED, n), "eeefff");
        vm.prank(acctA);
        sguard.setLimits(UNLIMITED, UNLIMITED, "eeefff");
        // Now a large send is in-limit — no code.
        _check(acctA, _eth(rcpt, 1 ether), "");
        assertEq(sguard.spentToday(acctA), 1 ether);
    }

    function test_limitCode_boundToNewLimits_and_nonce() public {
        uint64 n = sguard.opNonce(acctA);
        _issue(acctA, _limitDomain(acctA, 0.05 ether, 0.1 ether, n), "111333");
        // A code for (0.05, 0.1) must not authorize a different pair.
        vm.prank(acctA);
        vm.expectRevert();
        sguard.setLimits(0.06 ether, 0.1 ether, "111333");
        // The exact pair works.
        vm.prank(acctA);
        sguard.setLimits(0.05 ether, 0.1 ether, "111333");
    }

    function test_accountsIsolated() public {
        _check(acctA, _eth(rcpt, 0.008 ether), "");
        assertEq(sguard.spentToday(acctA), 0.008 ether);
        assertEq(sguard.spentToday(acctB), 0, "B untouched by A's spend");
        (uint128 p,) = sguard.limitsOf(acctB);
        assertEq(p, PER_TX, "B keeps its own defaults");
    }

    // =================== 4. adversarial (the named cases) ===================

    function test_thief_splitsPayments_boundedByDaily() public {
        // A codeless attacker drips in-limit sends; the total can never exceed daily.
        _check(acctA, _eth(rcpt, 0.008 ether), "");
        _check(acctA, _eth(rcpt, 0.008 ether), ""); // spent 0.016
        _checkReverts(acctA, _eth(rcpt, 0.005 ether), ""); // 0.021 > daily — blocked
        assertLe(sguard.spentToday(acctA), DAILY, "codeless spend never exceeds the daily cap");
    }

    function test_thief_raisesLimit_blockedByCode() public {
        vm.prank(acctA);
        vm.expectRevert();
        sguard.setLimits(1 ether, 1 ether, ""); // raise without code
        (uint128 p, uint128 d) = sguard.limitsOf(acctA);
        assertEq(p, PER_TX, "perTx unchanged");
        assertEq(d, DAILY, "daily unchanged");
        _checkReverts(acctA, _eth(rcpt, 0.5 ether), ""); // still can't over-send
    }

    function test_thief_paysPreviouslyUsedAddress_stillBounded() public {
        // Owner pays rcpt in-limit earlier.
        _check(acctA, _eth(rcpt, 0.005 ether), "");
        // A repeat over-limit send to the SAME address still needs a code — there is
        // no state that remembers rcpt, so no familiarity bypass exists.
        _checkReverts(acctA, _eth(rcpt, 0.015 ether), "");
        // In-limit repeats to rcpt are still bounded by the daily cap.
        _check(acctA, _eth(rcpt, 0.005 ether), ""); // 0.010
        _check(acctA, _eth(rcpt, 0.005 ether), ""); // 0.015
        _check(acctA, _eth(rcpt, 0.005 ether), ""); // 0.020
        _checkReverts(acctA, _eth(rcpt, 0.005 ether), ""); // 0.025 > daily — bounded even to a used address
    }

    function test_verifiedRecipient_overLimit_stillNeedsCode() public {
        // A Dojang-verified recipient gets NO bypass — identity gates nothing.
        _checkReverts(acctA, _eth(VERIFIED_RECIPIENT, 0.015 ether), "");
    }

    // =================== 5. ERC-20: every token op needs the code ===================

    function test_erc20Transfer_requiresCode() public {
        bytes memory data = _erc20Data(rcpt, 100);
        _checkReverts(acctA, Call({target: tokenAddr, value: 0, data: data}), ""); // no code
        uint64 n = sguard.opNonce(acctA);
        _issue(acctA, _tokenDomain(acctA, tokenAddr, data, n), "444777");
        _check(acctA, Call({target: tokenAddr, value: 0, data: data}), "444777");
        assertEq(sguard.opNonce(acctA), n + 1, "token op consumed a code");
    }

    // =================== 6. account integration (Decision A) ===================

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
        bytes32 sh =
            keccak256(abi.encode(keccak256("Init(bytes32 x,bytes32 y,address guard,address arise)"), x, y, g, ar));
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

    /// @dev A fresh V5 proxy account initialized with THIS spending guard as its
    ///      policy, then sensitiveOpLock engaged (Decision A). PASSKEY_PK signs.
    function _setUpBankAccount() internal {
        (bankAcct, bankPk) = makeAddrAndKey("bank-acct");
        vm.signAndAttachDelegation(address(proxyImpl), bankPk);
        bytes memory initData;
        {
            (uint256 x, uint256 y) = vm.publicKeyP256(PASSKEY_PK);
            (uint8 iv, bytes32 ir, bytes32 is_) =
                vm.sign(bankPk, _initDigest(bankAcct, bytes32(x), bytes32(y), address(sguard), address(arise)));
            initData = abi.encodeCall(
                OndolAccountV4.initializeWithSig, (bytes32(x), bytes32(y), address(sguard), address(arise), iv, ir, is_)
            );
        }
        {
            (uint8 pv, bytes32 pr, bytes32 ps) = vm.sign(bankPk, _proxyInitDigest(bankAcct, address(implV5)));
            vm.prank(relayer);
            OndolProxy(payable(bankAcct)).initialize(address(implV5), initData, pv, pr, ps);
        }
        vm.deal(bankAcct, 10 ether);
        // Engage sensitiveOpLock (passkey-only) so setGuard/upgradeTo/disable are code-gated.
        _execV5(_call(bankAcct, 0, abi.encodeCall(OndolAccountV4.enableSensitiveOpLock, ())), "", PASSKEY_PK, relayer);
        assertTrue(OndolAccountV5(payable(bankAcct)).sensitiveOpLock(), "lock engaged");
        assertEq(OndolAccountV5(payable(bankAcct)).guard(), address(sguard), "pointed at the spending guard");
    }

    function _call(address target, uint256 value, bytes memory data) internal pure returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call({target: target, value: value, data: data});
    }

    function _challengeV5(Call[] memory calls) internal view returns (bytes32) {
        return
            keccak256(abi.encode(bankAcct, block.chainid, OndolAccountV5(payable(bankAcct)).nonce(), calls, uint256(0)));
    }

    function _execV5(Call[] memory calls, string memory otp, uint256 pk, address submitter) internal {
        bytes memory sig = _signWebAuthn(pk, _challengeV5(calls));
        vm.prank(submitter);
        OndolAccountV5(payable(bankAcct)).execute(calls, otp, 0, sig);
    }

    function _execV5ExpectRevert(Call[] memory calls, string memory otp, uint256 pk, address submitter) internal {
        bytes memory sig = _signWebAuthn(pk, _challengeV5(calls));
        vm.prank(submitter);
        vm.expectRevert();
        OndolAccountV5(payable(bankAcct)).execute(calls, otp, 0, sig);
    }

    function test_execute_inLimitSend_oneTap() public {
        uint256 before = rcpt.balance;
        _execV5(_call(rcpt, 0.005 ether, ""), "", PASSKEY_PK, relayer); // in-limit; no code
        assertEq(rcpt.balance, before + 0.005 ether, "in-limit send landed via execute");
        assertEq(sguard.spentToday(bankAcct), 0.005 ether, "guard recorded the spend");
    }

    function test_execute_overLimitSend_withCode() public {
        uint64 n = sguard.opNonce(bankAcct);
        _issue(bankAcct, _ethDomain(bankAcct, rcpt, 0.015 ether, n), "abcabc");
        uint256 before = rcpt.balance;
        _execV5(_call(rcpt, 0.015 ether, ""), "abcabc", PASSKEY_PK, relayer); // over perTx; code threaded through
        assertEq(rcpt.balance, before + 0.015 ether, "over-limit send landed with the code");
        assertEq(sguard.opNonce(bankAcct), n + 1, "guard consumed the code");
    }

    function test_execute_overLimitSend_withoutCode_reverts() public {
        uint256 before = rcpt.balance;
        _execV5ExpectRevert(_call(rcpt, 0.015 ether, ""), "", PASSKEY_PK, relayer);
        assertEq(rcpt.balance, before, "no funds moved without the code");
    }

    function test_thief_setGuardToPermissive_noCode_reverts() public {
        address evil = makeAddr("permissive-guard");
        _execV5ExpectRevert(
            _call(bankAcct, 0, abi.encodeCall(OndolAccountV4.setGuard, (evil, ""))), "", PASSKEY_PK, thief
        );
        assertEq(OndolAccountV5(payable(bankAcct)).guard(), address(sguard), "guard un-swapped");
    }

    function test_thief_upgradeToGuardless_noCode_reverts() public {
        address evil = makeAddr("malicious-impl");
        _execV5ExpectRevert(
            _call(bankAcct, 0, abi.encodeCall(OndolAccountV4.upgradeTo, (evil, ""))), "", PASSKEY_PK, thief
        );
        assertEq(OndolAccountV5(payable(bankAcct)).implementation(), address(implV5), "impl unchanged");
    }

    function test_arise_stillRotates_whenBankModelEngaged() public {
        (uint256 nx, uint256 ny) = vm.publicKeyP256(PASSKEY2_PK);
        string memory domain = string.concat(
            "suho.arise:", bankAcct.toHexString(), ":", keccak256(abi.encode(bytes32(nx), bytes32(ny))).toHexString()
        );
        codes.issueCode(
            bankAcct,
            domain,
            keccak256(abi.encodePacked(bankAcct, domain, "654321")),
            uint64(block.timestamp + 10 minutes)
        );
        arise.arise(bankAcct, bytes32(nx), bytes32(ny), "654321");
        (bytes32 x2, bytes32 y2) = OndolAccountV5(payable(bankAcct)).passkey();
        assertEq(x2, bytes32(nx), "recovery rotates despite the bank model");
        assertEq(y2, bytes32(ny));
    }
}
