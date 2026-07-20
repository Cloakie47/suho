// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Call, IOndolTransferGuard} from "./interfaces/IOndolGuard.sol";
import {WebAuthnP256} from "./libs/WebAuthnP256.sol";

/// @title OndolAccount
/// @notice EIP-7702 smart-account implementation. An EOA (verified via Dojang,
///         holding an up.id) signs a one-time type-4 authorization delegating to
///         this contract; from then on the address is a smart account at the SAME
///         address, day-to-day operations authorized by a WebAuthn P-256 passkey.
///         The original EOA key can go in a drawer; a lost passkey is replaced via
///         AriseModule.
///
///         7702 storage rules: all state below lives at the EOA's own address, in
///         an ERC-7201 namespaced slot so future implementation upgrades (or other
///         delegations) cannot collide with it.
contract OndolAccount {
    error AlreadyInitialized();
    error NotInitialized();
    error NotSelf();
    error NotAriseModule();
    error InvalidPasskeySignature();
    error CallFailed(uint256 index, bytes returndata);

    event OndolInitialized(bytes32 pubKeyX, bytes32 pubKeyY, address guard, address ariseModule);
    event GuardSet(address guard);
    event PasskeyRotated(bytes32 newX, bytes32 newY);
    event Executed(uint256 indexed nonce, uint256 numCalls);

    /// @custom:storage-location erc7201:suho.ondol.account
    struct AccountStorage {
        bytes32 pubKeyX; // active passkey P-256 public key
        bytes32 pubKeyY;
        uint256 nonce; // replay protection for passkey-authorized execution
        address guard; // OndolTransferGuard (0 = no policy)
        address ariseModule; // sole address permitted to rotate keys
        bool initialized;
    }

    // keccak256(abi.encode(uint256(keccak256("suho.ondol.account")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT =
        0x18e1b3a892f6ed7c2fcd36c56d51fd8e3976dafbc1e7e8cb81cf8ca8dca57c00;

    function _s() private pure returns (AccountStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }

    /// @notice One-time setup, callable only by the account itself. On the 7702
    ///         path the delegated EOA simply sends a tx to its own address calling
    ///         this (msg.sender == address(this) for a self-call).
    function initialize(bytes32 x, bytes32 y, address guard_, address arise_) external {
        AccountStorage storage $ = _s();
        if ($.initialized) revert AlreadyInitialized();
        if (msg.sender != address(this)) revert NotSelf();

        $.pubKeyX = x;
        $.pubKeyY = y;
        $.guard = guard_;
        $.ariseModule = arise_;
        $.initialized = true;
        emit OndolInitialized(x, y, guard_, arise_);
    }

    /// @notice Execute a batch of calls authorized by a WebAuthn passkey assertion.
    ///         Anyone may relay (the relayer pays gas); authority comes solely from
    ///         the passkey signature over (account, chain, nonce, calls).
    /// @param otpCode Optional one-time code for guard-gated transfers (§1.2
    ///        REQUIRE_OTP); pass "" when no call needs one.
    function execute(Call[] calldata calls, string calldata otpCode, bytes calldata webAuthnSig)
        external
        payable
    {
        AccountStorage storage $ = _s();
        if (!$.initialized) revert NotInitialized();

        uint256 usedNonce = $.nonce;
        bytes32 challenge = keccak256(abi.encode(address(this), block.chainid, usedNonce, calls));
        if (!WebAuthnP256.verify(challenge, webAuthnSig, $.pubKeyX, $.pubKeyY)) {
            revert InvalidPasskeySignature();
        }
        $.nonce = usedNonce + 1;

        address guard_ = $.guard;
        for (uint256 i = 0; i < calls.length; i++) {
            if (guard_ != address(0)) {
                // Reverts (e.g. OtpRequired, CodeInvalid) block the whole batch.
                IOndolTransferGuard(guard_).check(calls[i], otpCode);
            }
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
        emit Executed(usedNonce, calls.length);
    }

    /// @notice Rotate the active passkey. Only AriseModule (after consuming a
    ///         purpose-bound recovery code) may call this.
    function rotatePasskey(bytes32 newX, bytes32 newY) external {
        AccountStorage storage $ = _s();
        if (msg.sender != $.ariseModule) revert NotAriseModule();
        $.pubKeyX = newX;
        $.pubKeyY = newY;
        emit PasskeyRotated(newX, newY);
    }

    /// @notice Swap the policy contract; only via self-call (i.e. an execute batch
    ///         targeting the account itself, or the dormant EOA key directly).
    function setGuard(address guard_) external {
        if (msg.sender != address(this)) revert NotSelf();
        _s().guard = guard_;
        emit GuardSet(guard_);
    }

    // ---- views ----

    function passkey() external view returns (bytes32 x, bytes32 y) {
        AccountStorage storage $ = _s();
        return ($.pubKeyX, $.pubKeyY);
    }

    function nonce() external view returns (uint256) {
        return _s().nonce;
    }

    function guard() external view returns (address) {
        return _s().guard;
    }

    function ariseModule() external view returns (address) {
        return _s().ariseModule;
    }

    function initialized() external view returns (bool) {
        return _s().initialized;
    }

    receive() external payable {}
}
