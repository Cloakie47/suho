// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Byte-identical to the real DojangScroll read interface on GIWA Sepolia.
interface IDojangScroll {
    function isVerified(address addr, bytes32 attesterId) external view returns (bool);
    function getVerifiedAddressAttestationUid(address addr, bytes32 attesterId) external view returns (bytes32);
}
