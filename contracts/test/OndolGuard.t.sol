// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {OndolTestBase} from "./OndolTestBase.sol";
import {OndolAccount} from "../src/OndolAccount.sol";
import {OndolTransferGuard} from "../src/OndolTransferGuard.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";
import {Call} from "../src/interfaces/IOndolGuard.sol";

/// @dev Just enough ERC-20 for the guard's transfer-calldata decoding path.
contract MiniToken {
    mapping(address => uint256) public balanceOf;

    constructor(address to, uint256 amount) {
        balanceOf[to] = amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Spec §3.3 — guard policy exercised through the full account execution path.
contract OndolGuardTest is OndolTestBase {
    string internal constant OTP = "728415";

    function test_verifiedRecipient_allowedWithoutWarning() public {
        vm.recordLogs();
        _execute(_ethTransfer(VERIFIED_RECIPIENT, 0.5 ether), "", PASSKEY_PK);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != OndolTransferGuard.UnverifiedRecipient.selector,
                "verified recipient must not warn"
            );
        }
    }

    function test_unverifiedSmall_allowedWithWarningEvent() public {
        uint256 amount = OTP_THRESHOLD - 1;
        vm.expectEmit(true, false, false, true, address(guard));
        emit OndolTransferGuard.UnverifiedRecipient(unverified, amount);

        _execute(_ethTransfer(unverified, amount), "", PASSKEY_PK);
        assertEq(unverified.balance, amount, "small send must go through");
    }

    function test_unverifiedLarge_withoutCode_revertsOtpRequired() public {
        Call[] memory calls = _ethTransfer(unverified, OTP_THRESHOLD);
        bytes memory sig = _signWebAuthn(PASSKEY_PK, _challenge(calls));

        vm.prank(relayer);
        vm.expectRevert(OndolTransferGuard.OtpRequired.selector);
        OndolAccount(payable(account)).execute(calls, "", sig);
    }

    function test_unverifiedLarge_withValidCode_succeedsAndConsumes() public {
        uint256 amount = 0.02 ether;
        _issueGuardOtp(unverified, amount, OTP);

        _execute(_ethTransfer(unverified, amount), OTP, PASSKEY_PK);
        assertEq(unverified.balance, amount);

        // Single-use: the same code cannot authorize the same transfer again.
        Call[] memory again = _ethTransfer(unverified, amount);
        bytes memory sig = _signWebAuthn(PASSKEY_PK, _challenge(again));
        vm.prank(relayer);
        vm.expectRevert(SuhoCodeAttester.CodeAlreadyUsed.selector);
        OndolAccount(payable(account)).execute(again, OTP, sig);
    }

    function test_otpBoundToDifferentRecipient_reverts() public {
        uint256 amount = 0.02 ether;
        address otherRecipient = makeAddr("other-recipient");
        _issueGuardOtp(otherRecipient, amount, OTP); // code minted for someone else

        // Guard derives the domain from the ACTUAL recipient, where no code is
        // active — the observed code is useless for this transfer.
        Call[] memory calls = _ethTransfer(unverified, amount);
        bytes memory sig = _signWebAuthn(PASSKEY_PK, _challenge(calls));
        vm.prank(relayer);
        vm.expectRevert(SuhoCodeAttester.CodeNotFound.selector);
        OndolAccount(payable(account)).execute(calls, OTP, sig);
    }

    function test_erc20LargeTransferToUnverified_requiresOtp() public {
        MiniToken token = new MiniToken(account, 100 ether);
        uint256 amount = 1 ether; // raw token amount >= wei threshold (v1 semantics)

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(token),
            value: 0,
            data: abi.encodeCall(MiniToken.transfer, (unverified, amount))
        });
        bytes memory sig = _signWebAuthn(PASSKEY_PK, _challenge(calls));
        vm.prank(relayer);
        vm.expectRevert(OndolTransferGuard.OtpRequired.selector);
        OndolAccount(payable(account)).execute(calls, "", sig);

        // With the properly-bound code, the token transfer goes through.
        _issueGuardOtp(unverified, amount, OTP);
        _execute(calls, OTP, PASSKEY_PK);
        assertEq(token.balanceOf(unverified), amount);
    }
}
