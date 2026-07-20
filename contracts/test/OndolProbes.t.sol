// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

/// @dev Minimal delegation target mirroring the Phase-0 live probe: any call
///      returns 42.
contract Ret42 {
    fallback() external payable {
        assembly {
            mstore(0, 42)
            return(0, 32)
        }
    }
}

/// @notice Spec §3.1 — the Phase-0 probes encoded as permanent fork tests
///         (both passed live on GIWA Sepolia on 2026-07-20).
contract OndolProbesTest is Test {
    address internal constant P256_VERIFIER = 0x0000000000000000000000000000000000000100;

    // RIP-7212 specification test vector: sha256 hash || r || s || x || y.
    bytes internal constant RIP7212_VALID_VECTOR =
        hex"4cee90eb86eaa050036147a12d49004b6b9c72bd725d39d4785011fe190f0b4d"
        hex"a73bd4903f0ce3b639bbbf6e8e80d16931ff4bcf5993d58468e8fb19086e8cac"
        hex"36dbcd03009df8c59286b162af3bd7fcc0450c9aa81be5d10d312af6c66b1d60"
        hex"4aebd3099c618202fcfe16ae7770b0c49ab5eadf74b754204a3bb6060e44eff3"
        hex"7618b065f9832de4ca6ca971a7a1adc826d0f7c00181a5fb2ddf79ae00b4e10e";

    function test_probeB_p256Verify_validVectorReturnsOne() public view {
        (bool ok, bytes memory ret) = P256_VERIFIER.staticcall(RIP7212_VALID_VECTOR);
        assertTrue(ok);
        assertEq(ret.length, 32);
        assertEq(bytes32(ret), bytes32(uint256(1)));
    }

    function test_probeB_p256Verify_corruptedVectorReturnsEmpty() public view {
        bytes memory corrupted = RIP7212_VALID_VECTOR;
        corrupted[159] ^= 0x01; // flip last byte of y
        (bool ok, bytes memory ret) = P256_VERIFIER.staticcall(corrupted);
        assertTrue(ok, "precompile call itself should not revert");
        assertEq(ret.length, 0, "invalid signature must return empty");
    }

    /// @dev 7702 delegate -> call -> un-delegate lifecycle with a fresh vm key
    ///      (never a real demo-wallet key). NOTE on nonces: the cheatcode signs
    ///      with the EOA's current nonce; live via cast, a self-submitted type-4
    ///      tx needs auth nonce = tx nonce + 1 (Phase-0 finding).
    function test_probeA_7702_delegateCallAndRollback() public {
        (address eoa, uint256 pk) = makeAddrAndKey("probe-7702-eoa");
        Ret42 target = new Ret42();

        vm.signAndAttachDelegation(address(target), pk);
        assertEq(eoa.code, abi.encodePacked(hex"ef0100", address(target)), "delegation designator");
        (bool ok, bytes memory ret) = eoa.call("");
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), 42, "EOA should execute delegated code");

        // Rollback: authorize address(0) to clear the delegation.
        vm.signAndAttachDelegation(address(0), pk);
        assertEq(eoa.code.length, 0, "delegation must be cleared");
        (ok, ret) = eoa.call("");
        assertTrue(ok);
        assertEq(ret.length, 0, "plain EOA call returns no data");
    }
}
