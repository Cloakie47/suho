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

/// @notice Guard policy exercised through the full account execution path.
///
///         The honest model (post-audit correction): a large transfer to an
///         unverified recipient is NOT gated by an independent one-time code. The
///         only thing that can move funds is the account's passkey signature, which
///         the account binds to the exact (recipient, value). These tests prove
///         exactly that — the send needs a valid passkey and nothing else, the
///         guard emits a loud `UnverifiedLargeSend`, and NO second-factor code is
///         ever consumed (there is none to consume).
contract OndolGuardTest is OndolTestBase {
    function test_verifiedRecipient_allowedWithoutWarning() public {
        vm.recordLogs();
        _execute(_ethTransfer(VERIFIED_RECIPIENT, 0.5 ether), "", PASSKEY_PK);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != OndolTransferGuard.UnverifiedRecipient.selector
                    && logs[i].topics[0] != OndolTransferGuard.UnverifiedLargeSend.selector,
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

    /// The core honest-behavior test: a large unverified send completes with a
    /// valid passkey and NO code, emits UnverifiedLargeSend, and consumes no
    /// second factor.
    function test_unverifiedLarge_allowedByPasskey_emitsEvent_noCodeConsumed() public {
        uint256 amount = 0.02 ether;

        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(guard));
        emit OndolTransferGuard.UnverifiedLargeSend(account, unverified, amount);
        _execute(_ethTransfer(unverified, amount), "", PASSKEY_PK);

        assertEq(unverified.balance, amount, "large unverified send must go through on passkey authority");

        // Prove no independent code was consumed: the attester never emitted a
        // CodeConsumed (there was no code to consume).
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != SuhoCodeAttester.CodeConsumed.selector,
                "no second-factor code may be consumed on the transfer path"
            );
        }
    }

    /// The passkey is the ONLY gate: a large unverified send with a wrong passkey
    /// reverts before any funds move.
    function test_unverifiedLarge_withoutValidPasskey_reverts() public {
        uint256 amount = 0.02 ether;
        Call[] memory calls = _ethTransfer(unverified, amount);
        // Sign with a DIFFERENT passkey than the account's registered key.
        bytes memory sig = _signWebAuthn(PASSKEY2_PK, _challenge(calls));

        uint256 nonceBefore = OndolAccount(payable(account)).nonce();
        vm.prank(relayer);
        vm.expectRevert(OndolAccount.InvalidPasskeySignature.selector);
        OndolAccount(payable(account)).execute(calls, "", sig);

        assertEq(unverified.balance, 0, "no funds may move without a valid passkey");
        assertEq(OndolAccount(payable(account)).nonce(), nonceBefore, "nonce must not advance on a rejected send");
    }

    /// ERC-20 large transfer to an unverified recipient: allowed on passkey
    /// authority, emits the honest event, no code consumed.
    function test_unverifiedLarge_erc20_allowedByPasskey() public {
        MiniToken token = new MiniToken(account, 100 ether);
        uint256 amount = 1 ether; // raw token amount >= wei threshold (v1 semantics)

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(token),
            value: 0,
            data: abi.encodeCall(MiniToken.transfer, (unverified, amount))
        });

        vm.expectEmit(true, true, false, true, address(guard));
        emit OndolTransferGuard.UnverifiedLargeSend(account, unverified, amount);
        _execute(calls, "", PASSKEY_PK);

        assertEq(token.balanceOf(unverified), amount, "erc20 large unverified transfer must go through");
    }
}
