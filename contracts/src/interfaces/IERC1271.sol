// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IERC1271
/// @notice EIP-1271 standard signature validation for smart-contract accounts.
///         A verifier calls isValidSignature and treats the account's signature as
///         valid iff it returns the magic value 0x1626ba7e.
interface IERC1271 {
    /// @param hash       Hash of the data that was signed.
    /// @param signature  Account-specific signature bytes.
    /// @return magicValue 0x1626ba7e when the signature is valid, else any other value.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4 magicValue);
}
