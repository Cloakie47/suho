// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Call, Verdict, IOndolTransferGuard} from "./interfaces/IOndolGuard.sol";
import {IDojangScroll} from "./interfaces/IDojangScroll.sol";

/// @title OndolTransferGuard
/// @notice Stateless transfer policy consulted by OndolAccount before each call.
///         Recipients verified by Dojang (any accepted attester) pass silently;
///         unverified recipients get a warning event below the OTP threshold and,
///         at or above it, a loud `UnverifiedLargeSend` event.
///
///         Honesty note (post-audit correction): a large transfer to an
///         unverified recipient is NOT gated by an independent one-time code. The
///         only authority that can move funds is the account's passkey signature,
///         which the account binds to the exact (recipient, value) in its execute
///         challenge — see OndolAccountV3.execute. The app additionally forces an
///         explicit hold-to-confirm before producing that signature. Both live
///         outside this guard. An earlier design minted a guard OTP on demand the
///         instant a valid passkey signature existed; because the same passkey
///         authorized both the mint and the send, that code added zero independent
///         security while appearing to. It was removed. This guard therefore emits
///         a distinct event and ALLOWs — it never signals a consumed second factor
///         that was not actually required. (A real, email-delivered second factor
///         is planned as account-level hardening; it is deliberately absent here so
///         nothing pretends to be it.)
contract OndolTransferGuard is IOndolTransferGuard {
    event UnverifiedRecipient(address indexed recipient, uint256 value);
    /// @notice A large transfer to an unverified recipient was allowed on the
    ///         account's passkey authority alone (plus the app's hold-to-confirm).
    ///         Deliberately NOT an "OtpConsumed" — no independent code gated this.
    event UnverifiedLargeSend(address indexed account, address indexed recipient, uint256 value);

    bytes4 private constant ERC20_TRANSFER_SELECTOR = 0xa9059cbb; // transfer(address,uint256)

    IDojangScroll public immutable scroll;
    uint256 public immutable otpThreshold;

    /// @dev Attester IDs come from DojangConfig at deploy time — never hardcoded here.
    bytes32[] private _acceptedAttesterIds;

    constructor(IDojangScroll _scroll, bytes32[] memory attesterIds, uint256 _otpThreshold) {
        scroll = _scroll;
        _acceptedAttesterIds = attesterIds;
        otpThreshold = _otpThreshold;
    }

    function acceptedAttesterIds() external view returns (bytes32[] memory) {
        return _acceptedAttesterIds;
    }

    /// @notice Policy check for one call; `msg.sender` is the account. Reverts to
    ///         block, otherwise the returned verdict is informational.
    ///         v1 scope: only plain ETH transfers (empty calldata) and ERC-20
    ///         `transfer` calldata are policed; other calls pass through (future
    ///         policy surface).
    /// @param code Unused. Retained so the account's `check(call, otpCode)` call
    ///        site and the IOndolTransferGuard interface stay stable; there is no
    ///        code path here to consume.
    function check(Call calldata call, string calldata code) external returns (Verdict) {
        code; // silence unused-parameter warning; intentionally ignored (see notice)
        (bool isTransfer, address recipient, uint256 value) = _decodeTransfer(call);
        if (!isTransfer) return Verdict.ALLOW;

        if (isVerifiedRecipient(recipient)) return Verdict.ALLOW;

        if (value < otpThreshold) {
            // Chain doesn't block small sends; the app renders the warning.
            emit UnverifiedRecipient(recipient, value);
            return Verdict.ALLOW_WITH_WARNING;
        }

        // Large transfer to an unverified recipient. Allowed on the account's
        // passkey authority alone (the account already bound the signature to this
        // exact recipient+value); the app forced an explicit hold-to-confirm. Emit
        // a loud, honest event — never a consumed-second-factor signal.
        emit UnverifiedLargeSend(msg.sender, recipient, value);
        return Verdict.ALLOW_WITH_WARNING;
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
