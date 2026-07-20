// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OndolTestBase} from "./OndolTestBase.sol";
import {OndolAccount} from "../src/OndolAccount.sol";
import {Call} from "../src/interfaces/IOndolGuard.sol";

/// @notice Spec §3.2 (execute) and §3.5 (7702 storage sanity).
contract OndolAccountTest is OndolTestBase {
    function test_execute_happyPath_verifiedRecipient() public {
        uint256 before = VERIFIED_RECIPIENT.balance;
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.5 ether);

        _execute(calls, "", PASSKEY_PK);

        assertEq(VERIFIED_RECIPIENT.balance, before + 0.5 ether);
        assertEq(OndolAccount(payable(account)).nonce(), 1);
    }

    function test_execute_nonceReplay_reverts() public {
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether);
        bytes memory sig = _signWebAuthn(PASSKEY_PK, _challenge(calls));

        vm.prank(relayer);
        OndolAccount(payable(account)).execute(calls, "", sig);

        // Same signature again: nonce advanced, challenge no longer matches.
        vm.prank(relayer);
        vm.expectRevert(OndolAccount.InvalidPasskeySignature.selector);
        OndolAccount(payable(account)).execute(calls, "", sig);
    }

    function test_execute_wrongKeySignature_reverts() public {
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether);
        bytes memory sig = _signWebAuthn(PASSKEY2_PK, _challenge(calls)); // not the active passkey

        vm.prank(relayer);
        vm.expectRevert(OndolAccount.InvalidPasskeySignature.selector);
        OndolAccount(payable(account)).execute(calls, "", sig);
    }

    function test_execute_tamperedCalls_reverts() public {
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether);
        bytes memory sig = _signWebAuthn(PASSKEY_PK, _challenge(calls));

        // Relayer swaps in a different batch after signing.
        Call[] memory tampered = _ethTransfer(unverified, 0.1 ether);
        vm.prank(relayer);
        vm.expectRevert(OndolAccount.InvalidPasskeySignature.selector);
        OndolAccount(payable(account)).execute(tampered, "", sig);
    }

    function test_initialize_secondCall_reverts() public {
        vm.prank(account);
        vm.expectRevert(OndolAccount.AlreadyInitialized.selector);
        OndolAccount(payable(account)).initialize(bytes32(0), bytes32(0), address(0), address(0));
    }

    function test_initialize_notSelf_reverts() public {
        // Fresh delegated, uninitialized account: a third party must not be able
        // to claim it.
        (address eoa2, uint256 pk2) = makeAddrAndKey("second-eoa");
        vm.signAndAttachDelegation(address(impl), pk2);

        vm.prank(relayer);
        vm.expectRevert(OndolAccount.NotSelf.selector);
        OndolAccount(payable(eoa2)).initialize(bytes32(0), bytes32(0), address(0), address(0));
    }

    /// @dev Spec §3.5 — delegate, initialize, un-delegate, re-delegate.
    ///      7702 semantics observed and asserted here: storage lives at the EOA's
    ///      address and SURVIVES delegation removal — clearing the delegation only
    ///      removes the code designator. On re-delegation the account resumes with
    ///      its prior state (passkey, nonce, guard) intact; ERC-7201 namespacing
    ///      means a different future implementation would not collide with it.
    function test_storageSanity_undelegateRedelegate_statePersists() public {
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.1 ether);
        _execute(calls, "", PASSKEY_PK);
        assertEq(OndolAccount(payable(account)).nonce(), 1);

        // Un-delegate (authorize address(0)): code gone, account is a plain EOA.
        vm.signAndAttachDelegation(address(0), accountEoaPk);
        assertEq(account.code.length, 0);
        (bool ok, bytes memory ret) = account.call(abi.encodeWithSignature("nonce()"));
        assertTrue(ok);
        assertEq(ret.length, 0, "plain EOA: no code to answer nonce()");

        // Re-delegate: same implementation, state resumes where it left off.
        vm.signAndAttachDelegation(address(impl), accountEoaPk);
        assertEq(OndolAccount(payable(account)).nonce(), 1, "nonce survived un-delegation");
        assertTrue(OndolAccount(payable(account)).initialized(), "initialized flag survived");
        (bytes32 x,) = OndolAccount(payable(account)).passkey();
        (uint256 expectedX,) = vm.publicKeyP256(PASSKEY_PK);
        assertEq(x, bytes32(expectedX), "passkey survived");

        // And the account still executes with the same passkey.
        _execute(_ethTransfer(VERIFIED_RECIPIENT, 0.1 ether), "", PASSKEY_PK);
        assertEq(OndolAccount(payable(account)).nonce(), 2);
    }
}
