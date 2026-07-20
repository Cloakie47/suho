// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OndolTestBase} from "./OndolTestBase.sol";
import {OndolAccount} from "../src/OndolAccount.sol";
import {AriseModule} from "../src/AriseModule.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";
import {Call} from "../src/interfaces/IOndolGuard.sol";

/// @notice Spec §3.4 — full Arise passkey-rotation flow.
contract OndolAriseTest is OndolTestBase {
    string internal constant RECOVERY_CODE = "301447";

    bytes32 internal newX;
    bytes32 internal newY;

    function setUp() public override {
        super.setUp();
        (uint256 x2, uint256 y2) = vm.publicKeyP256(PASSKEY2_PK);
        newX = bytes32(x2);
        newY = bytes32(y2);
    }

    function test_arise_fullRotation() public {
        _issueAriseCode(newX, newY, RECOVERY_CODE);

        // Anyone can relay the recovery.
        vm.expectEmit(true, false, false, true, address(arise));
        emit AriseModule.Arisen(account, newX, newY);
        vm.prank(relayer);
        arise.arise(account, newX, newY, RECOVERY_CODE);

        (bytes32 x, bytes32 y) = OndolAccount(payable(account)).passkey();
        assertEq(x, newX);
        assertEq(y, newY);

        // Old passkey stops working...
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether);
        bytes memory oldSig = _signWebAuthn(PASSKEY_PK, _challenge(calls));
        vm.prank(relayer);
        vm.expectRevert(OndolAccount.InvalidPasskeySignature.selector);
        OndolAccount(payable(account)).execute(calls, "", oldSig);

        // ...and the new one works.
        uint256 before = VERIFIED_RECIPIENT.balance;
        _execute(calls, "", PASSKEY2_PK);
        assertEq(VERIFIED_RECIPIENT.balance, before + 0.1 ether);
    }

    function test_arise_reusedCode_reverts() public {
        _issueAriseCode(newX, newY, RECOVERY_CODE);
        arise.arise(account, newX, newY, RECOVERY_CODE);

        vm.expectRevert(SuhoCodeAttester.CodeAlreadyUsed.selector);
        arise.arise(account, newX, newY, RECOVERY_CODE);
    }

    function test_arise_wrongNewKeyHash_reverts() public {
        _issueAriseCode(newX, newY, RECOVERY_CODE);

        // Attacker intercepts the code but tries to rotate in THEIR key: the
        // domain AriseModule derives commits to the attacker's key hash, where no
        // code was ever issued.
        (uint256 ax, uint256 ay) = vm.publicKeyP256(0xa77ac); // attacker key
        vm.expectRevert(SuhoCodeAttester.CodeNotFound.selector);
        arise.arise(account, bytes32(ax), bytes32(ay), RECOVERY_CODE);

        // The legitimate rotation still goes through afterwards.
        arise.arise(account, newX, newY, RECOVERY_CODE);
        (bytes32 x,) = OndolAccount(payable(account)).passkey();
        assertEq(x, newX);
    }

    function test_rotatePasskey_onlyAriseModule() public {
        vm.prank(relayer);
        vm.expectRevert(OndolAccount.NotAriseModule.selector);
        OndolAccount(payable(account)).rotatePasskey(newX, newY);
    }
}
