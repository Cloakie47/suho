// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Call, Verdict, IOndolTransferGuard} from "./interfaces/IOndolGuard.sol";
import {IDojangScroll} from "./interfaces/IDojangScroll.sol";
import {SuhoCodeAttester} from "./SuhoCodeAttester.sol";
import {HexStrings} from "./libs/HexStrings.sol";

/// @title OndolTransferGuard
/// @notice Stateless transfer policy consulted by OndolAccount before each call.
///         Recipients verified by Dojang (any accepted attester) pass silently;
///         unverified recipients get a warning event below the OTP threshold and
///         a mandatory purpose-bound one-time code at or above it.
contract OndolTransferGuard is IOndolTransferGuard {
    using HexStrings for address;
    using HexStrings for uint256;

    error OtpRequired();

    event UnverifiedRecipient(address indexed recipient, uint256 value);
    event OtpConsumed(address indexed account, address indexed recipient, uint256 value);

    bytes4 private constant ERC20_TRANSFER_SELECTOR = 0xa9059cbb; // transfer(address,uint256)

    IDojangScroll public immutable scroll;
    SuhoCodeAttester public immutable codes;
    uint256 public immutable otpThreshold;

    /// @dev Attester IDs come from DojangConfig at deploy time — never hardcoded here.
    bytes32[] private _acceptedAttesterIds;

    constructor(
        IDojangScroll _scroll,
        bytes32[] memory attesterIds,
        uint256 _otpThreshold,
        SuhoCodeAttester _codes
    ) {
        scroll = _scroll;
        _acceptedAttesterIds = attesterIds;
        otpThreshold = _otpThreshold;
        codes = _codes;
    }

    function acceptedAttesterIds() external view returns (bytes32[] memory) {
        return _acceptedAttesterIds;
    }

    /// @notice Policy check for one call; `msg.sender` is the account. Reverts to
    ///         block, otherwise the returned verdict is informational.
    ///         v1 scope: only plain ETH transfers (empty calldata) and ERC-20
    ///         `transfer` calldata are policed; other calls pass through (future
    ///         policy surface).
    function check(Call calldata call, string calldata code) external returns (Verdict) {
        (bool isTransfer, address recipient, uint256 value) = _decodeTransfer(call);
        if (!isTransfer) return Verdict.ALLOW;

        if (isVerifiedRecipient(recipient)) return Verdict.ALLOW;

        if (value < otpThreshold) {
            // Chain doesn't block small sends; the app renders the warning.
            emit UnverifiedRecipient(recipient, value);
            return Verdict.ALLOW_WITH_WARNING;
        }

        // Large transfer to an unverified recipient: require a purpose-bound OTP.
        // NOTE for ERC-20: `value` is the raw token amount compared against a wei
        // threshold — v1 demo semantics, matching the spec.
        if (bytes(code).length == 0) revert OtpRequired();

        string memory domain = string.concat(
            "suho.guard:",
            msg.sender.toHexString(),
            ":",
            recipient.toHexString(),
            ":",
            value.toDecimalString()
        );
        // Bubbles CodeNotFound / CodeInvalid / CodeExpired / CodeAlreadyUsed.
        codes.verifyAndConsume(msg.sender, domain, code);
        emit OtpConsumed(msg.sender, recipient, value);
        return Verdict.REQUIRE_OTP;
    }

    function isVerifiedRecipient(address recipient) public view returns (bool) {
        for (uint256 i = 0; i < _acceptedAttesterIds.length; i++) {
            if (scroll.isVerified(recipient, _acceptedAttesterIds[i])) return true;
        }
        return false;
    }

    function _decodeTransfer(Call calldata call)
        private
        pure
        returns (bool isTransfer, address recipient, uint256 value)
    {
        if (call.data.length == 0) {
            // Plain ETH transfer.
            return (true, call.target, call.value);
        }
        if (call.data.length == 68 && bytes4(call.data[:4]) == ERC20_TRANSFER_SELECTOR) {
            (recipient, value) = abi.decode(call.data[4:], (address, uint256));
            return (true, recipient, value);
        }
        return (false, address(0), 0);
    }
}
