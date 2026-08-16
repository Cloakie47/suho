// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Call, IOndolTransferGuard} from "./interfaces/IOndolGuard.sol";
import {WebAuthnP256} from "./libs/WebAuthnP256.sol";
import {HexStrings} from "./libs/HexStrings.sol";
import {SuhoCodeAttester} from "./SuhoCodeAttester.sol";

/// @dev Minimal view surface of the guard the account needs for the large-send
///      email factor: is the recipient verified, and what is the large-send
///      threshold. The deployed OndolTransferGuard implements both.
interface IGuardView {
    function isVerifiedRecipient(address recipient) external view returns (bool);
    function otpThreshold() external view returns (uint256);
}

/// @title OndolAccountV4
/// @notice Phase SEC 2.3: the honest, opt-in email second factor. Everything from
///         V3 carries over byte-for-byte (WebAuthn verify, capped gas
///         reimbursement, the guard hook, rotatePasskey, initializeWithSig,
///         upgradeTo, low-s discipline). V4 adds two INDEPENDENT, opt-in locks
///         that turn a passkey-only action into a 2-of-2 (passkey plus an
///         out-of-band email code the passkey cannot produce):
///
///         1. sensitiveOpLock (account control): when on, setGuard, upgradeTo and
///            disabling the lock require an email-delivered code, consumed via
///            SuhoCodeAttester, domain-bound to (op, account, params, nonce).
///            Enabling the lock is passkey-only (strengthening). This closes the
///            passkey-only takeover: a stolen device cannot repoint the guard or
///            install a malicious implementation.
///
///         2. emailLargeSendLock (transfers): when on, a large send to an
///            unverified recipient requires an email code bound to the exact
///            (recipient, value). ETH only in this version; a large unverified
///            ERC-20 send reverts LargeSendErc20NotSupported until the in-account
///            token decode is audited, so nothing is silently unprotected.
///
///         Recovery is deliberately NOT gated: rotatePasskey (AriseModule) works
///         regardless of the locks, so a locked, passkey-compromised account is
///         still recoverable through Arise.
///
///         Storage: identical ERC-7201 namespace as V1/V2/V3. Three fields are
///         APPENDED to AccountStorage; every existing account reads them as
///         false/0, so V4 is byte-identical to V3 until a lock is enabled. The two
///         new bools pack into the final V3 word (alongside ariseModule and
///         initialized) in previously-zero bytes; the storage-collision test
///         proves the packed write never disturbs an existing field.
contract OndolAccountV4 {
    using HexStrings for address;
    using HexStrings for bytes32;

    error AlreadyInitialized();
    error NotInitialized();
    error InvalidInitSignature();
    error NotSelf();
    error NotAriseModule();
    error InvalidPasskeySignature();
    error CallFailed(uint256 index, bytes returndata);
    error CannotCoverGas();
    error LargeSendErc20NotSupported();

    event OndolInitialized(bytes32 pubKeyX, bytes32 pubKeyY, address guard, address ariseModule);
    event GuardSet(address guard);
    event PasskeyRotated(bytes32 newX, bytes32 newY);
    event Executed(uint256 indexed nonce, uint256 numCalls);
    event GasReimbursed(address indexed payer, uint256 amount);
    event Upgraded(address indexed implementation);
    event SensitiveOpLockSet(bool engaged);
    event EmailLargeSendLockSet(bool engaged);

    /// @custom:storage-location erc7201:suho.ondol.account
    struct AccountStorage {
        bytes32 pubKeyX; // active passkey P-256 public key
        bytes32 pubKeyY;
        uint256 nonce; // replay protection for passkey-authorized execution
        address guard; // OndolTransferGuard (0 = no policy)
        address ariseModule; // sole address permitted to rotate keys
        bool initialized;
        // ---- V4 additions (append-only; V1/V2/V3 accounts read these as 0) ----
        bool sensitiveOpLock; // opt-in: gate setGuard/upgradeTo/disable behind an email code
        bool emailLargeSendLock; // opt-in: gate large unverified sends behind an email code
        uint256 sensitiveOpNonce; // increments on every consumed sensitive-op code
    }

    // keccak256(abi.encode(uint256(keccak256("suho.ondol.account")) - 1)) & ~bytes32(uint256(0xff))
    // MUST match v1/v2/v3 — migrated accounts read the same slots.
    bytes32 private constant STORAGE_SLOT =
        0x18e1b3a892f6ed7c2fcd36c56d51fd8e3976dafbc1e7e8cb81cf8ca8dca57c00;

    bytes32 private constant IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant INIT_TYPEHASH =
        keccak256("Init(bytes32 x,bytes32 y,address guard,address arise)");

    uint256 private constant SECP256K1_N_DIV_2 =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint256 private constant FIXED_OVERHEAD = 45_000;
    address private constant GAS_ORACLE = 0x420000000000000000000000000000000000000F;
    uint256 private constant L1_SIZE_ESTIMATE = 1200;
    uint256 private constant L1_ALLOWANCE = 70_000_000_000;

    bytes4 private constant ERC20_TRANSFER_SELECTOR = 0xa9059cbb; // transfer(address,uint256)

    /// @notice The Suho code attester. Immutable, so it lives in this
    ///         implementation's code and is read correctly even when executed via
    ///         the proxy's delegatecall. Set to the deployed SuhoCodeAttester in
    ///         production, and to the test attester in the fork suite.
    SuhoCodeAttester public immutable codeAttester;

    constructor(SuhoCodeAttester _codeAttester) {
        codeAttester = _codeAttester;
    }

    function _s() private pure returns (AccountStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }

    // ---- init (byte-for-byte V2/V3) ----

    function initializeWithSig(
        bytes32 x,
        bytes32 y,
        address guard_,
        address arise_,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        AccountStorage storage $ = _s();
        if ($.initialized) revert AlreadyInitialized();
        if (uint256(s) > SECP256K1_N_DIV_2) revert InvalidInitSignature();

        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("Suho Ondol")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(abi.encode(INIT_TYPEHASH, x, y, guard_, arise_));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        address recovered = ecrecover(digest, v, r, s);
        if (recovered != address(this)) revert InvalidInitSignature();

        $.pubKeyX = x;
        $.pubKeyY = y;
        $.guard = guard_;
        $.ariseModule = arise_;
        $.initialized = true;
        emit OndolInitialized(x, y, guard_, arise_);
    }

    // ---- execute (V3 semantics + G2 large-send factor in the call loop) ----

    function execute(
        Call[] calldata calls,
        string calldata otpCode,
        uint256 maxGasPayment,
        bytes calldata webAuthnSig
    ) external payable {
        uint256 gasStart = gasleft();
        AccountStorage storage $ = _s();
        if (!$.initialized) revert NotInitialized();

        if (maxGasPayment != 0 && address(this).balance < maxGasPayment) revert CannotCoverGas();

        uint256 usedNonce = $.nonce;
        if (
            !WebAuthnP256.verify(
                keccak256(abi.encode(address(this), block.chainid, usedNonce, calls, maxGasPayment)),
                webAuthnSig,
                $.pubKeyX,
                $.pubKeyY
            )
        ) {
            revert InvalidPasskeySignature();
        }
        $.nonce = usedNonce + 1;

        _runCalls(calls, otpCode, $.guard, $.emailLargeSendLock);
        emit Executed(usedNonce, calls.length);

        if (maxGasPayment != 0) _reimburse(gasStart, maxGasPayment);
    }

    function _runCalls(
        Call[] calldata calls,
        string calldata otpCode,
        address guard_,
        bool largeSendLock
    ) private {
        for (uint256 i = 0; i < calls.length; i++) {
            if (guard_ != address(0)) {
                IOndolTransferGuard(guard_).check(calls[i], otpCode);
                // G2: opt-in email factor for a large unverified send.
                if (largeSendLock) _enforceLargeSendFactor(calls[i], otpCode, guard_);
            }
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
    }

    /// @dev When emailLargeSendLock is on: a large ETH send to an unverified
    ///      recipient requires an email code bound to (account, recipient, value).
    ///      A large unverified ERC-20 send reverts until the token decode is
    ///      audited (decision: ETH-only for now). Non-transfers and verified or
    ///      sub-threshold transfers pass untouched.
    function _enforceLargeSendFactor(Call calldata call, string calldata code, address guard_) private {
        uint256 threshold = IGuardView(guard_).otpThreshold();

        if (call.data.length == 0) {
            // Native ETH transfer.
            if (call.value >= threshold && !IGuardView(guard_).isVerifiedRecipient(call.target)) {
                string memory domain = string.concat(
                    "suho.send:",
                    address(this).toHexString(),
                    ":",
                    call.target.toHexString(),
                    ":",
                    bytes32(call.value).toHexString()
                );
                codeAttester.verifyAndConsume(address(this), domain, code);
            }
            return;
        }

        // ERC-20 transfer(recipient, amount): only need to detect a LARGE
        // UNVERIFIED one to reject it (ETH-only email factor for now).
        if (call.data.length == 68 && bytes4(call.data[:4]) == ERC20_TRANSFER_SELECTOR) {
            (address recipient, uint256 amount) = abi.decode(call.data[4:], (address, uint256));
            if (amount >= threshold && !IGuardView(guard_).isVerifiedRecipient(recipient)) {
                revert LargeSendErc20NotSupported();
            }
        }
    }

    function _reimburse(uint256 gasStart, uint256 maxGasPayment) private {
        uint256 gasUsed = gasStart - gasleft() + FIXED_OVERHEAD;
        uint256 payment = gasUsed * tx.gasprice + _l1FeeUpperBound();
        if (payment > maxGasPayment) payment = maxGasPayment;
        if (payment != 0) {
            (bool paid,) = msg.sender.call{value: payment}("");
            if (!paid) revert CannotCoverGas();
            emit GasReimbursed(msg.sender, payment);
        }
    }

    // ---- recovery (unchanged, NEVER gated by the locks) ----

    function rotatePasskey(bytes32 newX, bytes32 newY) external {
        AccountStorage storage $ = _s();
        if (msg.sender != $.ariseModule) revert NotAriseModule();
        $.pubKeyX = newX;
        $.pubKeyY = newY;
        emit PasskeyRotated(newX, newY);
    }

    // ---- G1 control ops (self-call; email code required when locked) ----

    /// @notice Swap the policy contract. Self-call only. When sensitiveOpLock is
    ///         on, an email code bound to (setguard, account, newGuard, nonce) is
    ///         required and consumed; when off, `code` is ignored (V3 behaviour).
    function setGuard(address guard_, string calldata code) external {
        if (msg.sender != address(this)) revert NotSelf();
        _consumeIfLocked("setguard", guard_, code);
        _s().guard = guard_;
        emit GuardSet(guard_);
    }

    /// @notice Move the account to a new implementation. Self-call only. Email
    ///         code required when sensitiveOpLock is on.
    function upgradeTo(address newImplementation, string calldata code) external {
        if (msg.sender != address(this)) revert NotSelf();
        _consumeIfLocked("upgrade", newImplementation, code);
        assembly {
            sstore(IMPL_SLOT, newImplementation)
        }
        emit Upgraded(newImplementation);
    }

    /// @notice Engage the control lock. Self-call (passkey) only; strengthening,
    ///         so no email code. The app must ensure a recovery email exists first
    ///         (off chain), else the lock can only be lifted through Arise.
    function enableSensitiveOpLock() external {
        if (msg.sender != address(this)) revert NotSelf();
        _s().sensitiveOpLock = true;
        emit SensitiveOpLockSet(true);
    }

    /// @notice Disengage the control lock. Self-call only. Always requires an email
    ///         code when the lock is on (disabling is the dangerous direction), so
    ///         a passkey-only attacker cannot turn it off.
    function disableSensitiveOpLock(string calldata code) external {
        if (msg.sender != address(this)) revert NotSelf();
        AccountStorage storage $ = _s();
        if ($.sensitiveOpLock) {
            string memory domain = string.concat(
                "suho.op:disablelock:",
                address(this).toHexString(),
                ":",
                bytes32($.sensitiveOpNonce).toHexString()
            );
            codeAttester.verifyAndConsume(address(this), domain, code);
            $.sensitiveOpNonce = $.sensitiveOpNonce + 1;
        }
        $.sensitiveOpLock = false;
        emit SensitiveOpLockSet(false);
    }

    /// @notice Engage the large-send email factor. Self-call only; strengthening.
    function enableEmailLargeSendLock() external {
        if (msg.sender != address(this)) revert NotSelf();
        _s().emailLargeSendLock = true;
        emit EmailLargeSendLockSet(true);
    }

    /// @notice Disengage the large-send email factor. Self-call only; requires an
    ///         email code when the CONTROL lock is on (so protection cannot be
    ///         stripped by a passkey-only attacker on a fully-locked account),
    ///         bound to (disablesendlock, account, nonce).
    function disableEmailLargeSendLock(string calldata code) external {
        if (msg.sender != address(this)) revert NotSelf();
        AccountStorage storage $ = _s();
        if ($.sensitiveOpLock) {
            string memory domain = string.concat(
                "suho.op:disablesendlock:",
                address(this).toHexString(),
                ":",
                bytes32($.sensitiveOpNonce).toHexString()
            );
            codeAttester.verifyAndConsume(address(this), domain, code);
            $.sensitiveOpNonce = $.sensitiveOpNonce + 1;
        }
        $.emailLargeSendLock = false;
        emit EmailLargeSendLockSet(false);
    }

    /// @dev Consume an email code for a control op when the lock is on, binding it
    ///      to (op, account, param, nonce), then advance the nonce so every other
    ///      outstanding code is invalidated. No-op when the lock is off.
    function _consumeIfLocked(string memory op, address param, string calldata code) private {
        AccountStorage storage $ = _s();
        if (!$.sensitiveOpLock) return;
        string memory domain = string.concat(
            "suho.op:",
            op,
            ":",
            address(this).toHexString(),
            ":",
            param.toHexString(),
            ":",
            bytes32($.sensitiveOpNonce).toHexString()
        );
        codeAttester.verifyAndConsume(address(this), domain, code);
        $.sensitiveOpNonce = $.sensitiveOpNonce + 1;
    }

    function _l1FeeUpperBound() private view returns (uint256) {
        (bool ok, bytes memory ret) =
            GAS_ORACLE.staticcall(abi.encodeWithSignature("getL1FeeUpperBound(uint256)", L1_SIZE_ESTIMATE));
        if (ok && ret.length >= 32) return abi.decode(ret, (uint256));
        return L1_ALLOWANCE;
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

    function sensitiveOpLock() external view returns (bool) {
        return _s().sensitiveOpLock;
    }

    function emailLargeSendLock() external view returns (bool) {
        return _s().emailLargeSendLock;
    }

    function sensitiveOpNonce() external view returns (uint256) {
        return _s().sensitiveOpNonce;
    }

    function implementation() external view returns (address impl) {
        assembly {
            impl := sload(IMPL_SLOT)
        }
    }

    receive() external payable {}
}
