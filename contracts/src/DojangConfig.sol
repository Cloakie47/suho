// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Single source of truth for Dojang/EAS addresses and attester IDs.
///         No other contract may hardcode an attester ID (spec §9).
library DojangConfig {
    // ---- GIWA Sepolia (chain ID 91342) ----
    uint256 internal constant GIWA_SEPOLIA_CHAIN_ID = 91342;

    // OP-stack predeploys
    address internal constant EAS = 0x4200000000000000000000000000000000000021;
    address internal constant SCHEMA_REGISTRY = 0x4200000000000000000000000000000000000020;

    // Dojang contracts
    address internal constant DOJANG_SCROLL = 0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9;
    address internal constant ATTESTATION_INDEXER = 0x9C9Bf29880448aB39795a11b669e22A0f1d790ec;
    address internal constant DOJANG_ATTESTER_BOOK = 0xDA282E89244424E297Ce8e78089B54D043FB28B6;

    // Attester IDs (both live on testnet)
    bytes32 internal constant ATTESTER_UPBIT_KOREA =
        0xd99b42e778498aa3c9c1f6a012359130252780511687a35982e8e52735453034;
    bytes32 internal constant ATTESTER_TESTNET_FAUCET =
        0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678;

    // Official Verified Code schema UID (reference only — we never attest under it)
    bytes32 internal constant OFFICIAL_VERIFIED_CODE_SCHEMA_UID =
        0x55ac1369dac97522d062b89ffdc4e752b48fbeba86915fdb956c7c2d0501d280;

    /// @notice Attester IDs accepted for verification checks, in preference order.
    ///         TESTNET FAUCET first (hackathon demo), UPBIT KOREA second (mainnet path).
    function acceptedAttesterIds() internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](2);
        ids[0] = ATTESTER_TESTNET_FAUCET;
        ids[1] = ATTESTER_UPBIT_KOREA;
    }
}
