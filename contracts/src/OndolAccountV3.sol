// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Call, IOndolTransferGuard} from "./interfaces/IOndolGuard.sol";
import {WebAuthnP256} from "./libs/WebAuthnP256.sol";

/// @title OndolAccountV3
/// @notice Phase G: capped, signed gas reimbursement plus a passkey-gated
///         upgrade path. Everything from V2 carries over unchanged — WebAuthn
///         verification, the guard hook, rotatePasskey, initializeWithSig, and
///         low-s discipline on both curves — with two additions:
///
///         1. execute() reimburses whoever paid the gas, up to a cap the passkey
///            signed. Without a signed cap a relayer could inflate gas or gas
///            price and drain the account, so the cap (maxGasPayment) is part of
///            the signed challenge. The account pays min(actualCost, cap), and
///            biases high within the cap (upper-bound L1, padded overhead) so the
///            relayer is made whole or slightly over, never under.
///
///         2. upgradeTo() moves the account to a new implementation. It is
///            reachable only through a passkey-signed execute() batch targeting
///            the account itself, so the passkey is the sole upgrade authority.
///            It takes effect only behind OndolProxy (see OndolProxy); a legacy
///            account delegated straight to an implementation keeps working but
///            cannot upgrade, exactly as the migration note states.
///
///         Storage: identical ERC-7201 namespace as V1/V2, so a V2 account
///         re-delegated (via the proxy) to V3 keeps its passkey, nonce, guard and
///         arise wiring with no re-initialization. The implementation pointer is
///         ERC-1967, deliberately outside our namespace.
contract OndolAccountV3 {
    error AlreadyInitialized();
    error NotInitialized();
    error InvalidInitSignature();
    error NotSelf();
    error NotAriseModule();
    error InvalidPasskeySignature();
    error CallFailed(uint256 index, bytes returndata);
    error CannotCoverGas();

    event OndolInitialized(bytes32 pubKeyX, bytes32 pubKeyY, address guard, address ariseModule);
    event GuardSet(address guard);
    event PasskeyRotated(bytes32 newX, bytes32 newY);
    event Executed(uint256 indexed nonce, uint256 numCalls);
    event GasReimbursed(address indexed payer, uint256 amount);
    event Upgraded(address indexed implementation);

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
    // MUST match v1/v2 — migrated accounts read the same slots.
    bytes32 private constant STORAGE_SLOT =
        0x18e1b3a892f6ed7c2fcd36c56d51fd8e3976dafbc1e7e8cb81cf8ca8dca57c00;

    // ERC-1967 implementation slot — MUST match OndolProxy. Written only by
    // upgradeTo (self-call), read only by the proxy's fallback.
    bytes32 private constant IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant INIT_TYPEHASH =
        keccak256("Init(bytes32 x,bytes32 y,address guard,address arise)");

    /// @dev secp256k1 order / 2 — only low-s signatures accepted.
    uint256 private constant SECP256K1_N_DIV_2 =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ---- gas reimbursement constants (tuned from Phase G0 probes) ----

    /// @dev Intrinsic gas (21k), execute() calldata, and the reimbursement
    ///      transfer itself — none visible to the in-function gasleft() meter.
    uint256 private constant FIXED_OVERHEAD = 45_000;

    /// @dev OP-Stack GasPriceOracle predeploy.
    address private constant GAS_ORACLE = 0x420000000000000000000000000000000000000F;

    /// @dev Representative unsigned tx size (bytes) for getL1FeeUpperBound; Phase
    ///      G0 measured live executes at ~868–1200 bytes of calldata.
    uint256 private constant L1_SIZE_ESTIMATE = 1200;

    /// @dev Fallback L1 allowance (wei) if the oracle is absent or reverts, so a
    ///      predeploy change can never brick execute(). ~0.00000007 ETH, above
    ///      every L1 fee Phase G0 observed and above the current upper bound.
    uint256 private constant L1_ALLOWANCE = 70_000_000_000;

    function _s() private pure returns (AccountStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }

    /// @notice One-time setup, submittable by anyone (the relayer pays gas);
    ///         authority is an EIP-712 signature from the EOA's own key. Byte-for
    ///         -byte V2 semantics — the domain binds chainId AND verifyingContract.
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

    /// @notice Execute a batch authorized by a WebAuthn passkey assertion, then
    ///         reimburse the gas payer up to a signed cap.
    /// @param otpCode Optional one-time code for guard-gated transfers; "" when
    ///        no call needs one.
    /// @param maxGasPayment Max wei of gas reimbursement the passkey authorizes.
    ///        0 = sponsored (no reimbursement), identical to V2. The value is part
    ///        of the signed challenge, so a relayer cannot raise it.
    function execute(
        Call[] calldata calls,
        string calldata otpCode,
        uint256 maxGasPayment,
        bytes calldata webAuthnSig
    ) external payable {
        uint256 gasStart = gasleft();
        AccountStorage storage $ = _s();
        if (!$.initialized) revert NotInitialized();

        // Doomed-tx guard: if the account cannot cover the authorized cap, refuse
        // before verifying or executing, so the relayer never burns gas on it.
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

        _runCalls(calls, otpCode, $.guard);
        emit Executed(usedNonce, calls.length);

        // Sponsored path (onboarding, operator-sponsored): pay nothing, exactly
        // like V2. Otherwise reimburse min(actualCost, cap) to whoever paid gas.
        if (maxGasPayment != 0) _reimburse(gasStart, maxGasPayment);
    }

    /// @dev The guard-checked call loop, split out to keep execute() off the
    ///      "stack too deep" edge.
    function _runCalls(Call[] calldata calls, string calldata otpCode, address guard_) private {
        for (uint256 i = 0; i < calls.length; i++) {
            if (guard_ != address(0)) {
                // Reverts (e.g. OtpRequired, CodeInvalid) block the whole batch.
                IOndolTransferGuard(guard_).check(calls[i], otpCode);
            }
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
    }

    /// @dev Reimburse msg.sender min(actualCost, cap). Biases high within the cap
    ///      (upper-bound L1, padded overhead) so the payer is never left short.
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

    /// @notice Rotate the active passkey. Only AriseModule (after consuming a
    ///         purpose-bound recovery code) may call this.
    function rotatePasskey(bytes32 newX, bytes32 newY) external {
        AccountStorage storage $ = _s();
        if (msg.sender != $.ariseModule) revert NotAriseModule();
        $.pubKeyX = newX;
        $.pubKeyY = newY;
        emit PasskeyRotated(newX, newY);
    }

    /// @notice Swap the policy contract; only via self-call.
    function setGuard(address guard_) external {
        if (msg.sender != address(this)) revert NotSelf();
        _s().guard = guard_;
        emit GuardSet(guard_);
    }

    /// @notice Move the account to a new implementation. Reachable only through a
    ///         passkey-signed execute() batch targeting the account itself
    ///         (msg.sender == address(this)), so the passkey is the sole upgrade
    ///         authority — no admin, owner or guardian. Writes the ERC-1967 slot
    ///         the proxy reads; on a legacy account with no proxy this writes an
    ///         unused slot and has no effect.
    function upgradeTo(address newImplementation) external {
        if (msg.sender != address(this)) revert NotSelf();
        assembly {
            sstore(IMPL_SLOT, newImplementation)
        }
        emit Upgraded(newImplementation);
    }

    /// @dev Upper-bound L1 fee via the OP-Stack oracle (Fjord, O(1)), staticcall
    ///      -wrapped with a constant fallback so a missing or changed predeploy
    ///      can never brick execute().
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

    /// @notice The active implementation behind the proxy (ERC-1967). Lets the
    ///         guardian/app report which impl an account runs and whether it is
    ///         upgradeable (non-zero here => proxy-fronted).
    function implementation() external view returns (address impl) {
        assembly {
            impl := sload(IMPL_SLOT)
        }
    }

    receive() external payable {}
}
