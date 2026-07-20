// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A single call the account executes on behalf of its owner.
struct Call {
    address target;
    uint256 value;
    bytes data;
}

enum Verdict {
    ALLOW,
    ALLOW_WITH_WARNING,
    REQUIRE_OTP
}

/// @notice Transfer policy checked by OndolAccount before each call.
///         `account` is msg.sender; a non-reverting return means the call may proceed.
interface IOndolTransferGuard {
    function check(Call calldata call, string calldata code) external returns (Verdict);
}
