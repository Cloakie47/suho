// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IDojangScroll} from "../src/interfaces/IDojangScroll.sol";
import {DojangConfig} from "../src/DojangConfig.sol";

/// @notice Toy consumer proving the docs' `onlyVerified` pattern works against the
///         real DojangScroll with a configurable (constructor-injected) attester ID.
contract VerifiedGate {
    IDojangScroll public immutable scroll;
    bytes32 public immutable attesterId;

    error NotVerified(address addr);

    constructor(IDojangScroll _scroll, bytes32 _attesterId) {
        scroll = _scroll;
        attesterId = _attesterId;
    }

    modifier onlyVerified() {
        if (!scroll.isVerified(msg.sender, attesterId)) revert NotVerified(msg.sender);
        _;
    }

    function ping() external view onlyVerified returns (bool) {
        return true;
    }
}

/// @dev Fork tests against the real DojangScroll on GIWA Sepolia:
///      forge test --fork-url https://sepolia-rpc.giwa.io
contract DojangReadTest is Test {
    // Playground-verified demo wallet (holds suho.up.id).
    address internal constant VERIFIED_WALLET = 0x23f76916A462adC7583E31e8b4650d51De437eE2;
    address internal constant FRESH_WALLET = address(0xF4E5A11);
    bytes32 internal constant BOGUS_ATTESTER_ID = keccak256("suho.bogus.attester");

    IDojangScroll internal scroll;

    function setUp() public {
        scroll = IDojangScroll(DojangConfig.DOJANG_SCROLL);
    }

    /// @dev Returns the first configured attester ID that has verified the demo
    ///      wallet, so the suite doesn't hardcode which attester the Playground used.
    function _liveAttesterId() internal view returns (bytes32) {
        bytes32[] memory ids = DojangConfig.acceptedAttesterIds();
        for (uint256 i = 0; i < ids.length; i++) {
            if (scroll.isVerified(VERIFIED_WALLET, ids[i])) return ids[i];
        }
        revert("demo wallet not verified under any configured attester");
    }

    /// @notice Diagnostic: logs isVerified for the demo wallet under BOTH configured
    ///         attester IDs. Asserts only that at least one is live.
    function test_diagnostic_whichAttesterVerifiedDemoWallet() public view {
        bool faucet = scroll.isVerified(VERIFIED_WALLET, DojangConfig.ATTESTER_TESTNET_FAUCET);
        bool upbit = scroll.isVerified(VERIFIED_WALLET, DojangConfig.ATTESTER_UPBIT_KOREA);

        console2.log("demo wallet:", VERIFIED_WALLET);
        console2.log("  TESTNET FAUCET attester ->", faucet);
        console2.log("  UPBIT KOREA attester    ->", upbit);

        assertTrue(faucet || upbit, "demo wallet not verified under any configured attester");
    }

    function test_isVerified_trueForPlaygroundVerifiedWallet() public view {
        bytes32 live = _liveAttesterId();
        assertTrue(scroll.isVerified(VERIFIED_WALLET, live));

        bytes32 uid = scroll.getVerifiedAddressAttestationUid(VERIFIED_WALLET, live);
        assertTrue(uid != bytes32(0), "verified wallet should have an attestation uid");
    }

    function test_isVerified_falseForFreshAddress() public view {
        bytes32[] memory ids = DojangConfig.acceptedAttesterIds();
        for (uint256 i = 0; i < ids.length; i++) {
            assertFalse(scroll.isVerified(FRESH_WALLET, ids[i]));
        }
    }

    function test_isVerified_falseForBogusAttesterId() public view {
        assertFalse(scroll.isVerified(VERIFIED_WALLET, BOGUS_ATTESTER_ID));
    }

    // ---- Consumer parity (spec §6.3) ----

    function test_onlyVerified_allowsVerifiedWallet() public {
        VerifiedGate gate = new VerifiedGate(scroll, _liveAttesterId());
        vm.prank(VERIFIED_WALLET);
        assertTrue(gate.ping());
    }

    function test_onlyVerified_rejectsUnverifiedWallet() public {
        VerifiedGate gate = new VerifiedGate(scroll, _liveAttesterId());
        vm.prank(FRESH_WALLET);
        vm.expectRevert(abi.encodeWithSelector(VerifiedGate.NotVerified.selector, FRESH_WALLET));
        gate.ping();
    }

    function test_onlyVerified_attesterIdIsConfigurable() public {
        // Same wallet, bogus attester ID injected -> gate rejects, proving the
        // check follows the configured ID rather than any baked-in constant.
        VerifiedGate gate = new VerifiedGate(scroll, BOGUS_ATTESTER_ID);
        vm.prank(VERIFIED_WALLET);
        vm.expectRevert(abi.encodeWithSelector(VerifiedGate.NotVerified.selector, VERIFIED_WALLET));
        gate.ping();
    }
}
