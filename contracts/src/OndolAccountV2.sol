// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Call, IOndolTransferGuard} from "./interfaces/IOndolGuard.sol";
import {WebAuthnP256} from "./libs/WebAuthnP256.sol";

/// @title OndolAccountV2
/// @notice Phase O: signature-gated initialization for non-custodial, gasless
///         onboarding. V1 required the EOA to send its own initialize() tx
///         (needing gas on the EOA); V2 lets ANY relayer submit initialization,
///         authorized by an EIP-712 signature from the EOA's own key — on an
///         EIP-7702 account, `address(this)` IS the EOA, so only its secp256k1
///         key can authorize the first passkey. The browser generates that key,
///         signs the 7702 authorization + this init digest, and discards it.
///
///         Storage: identical ERC-7201 namespace as v1 — an account initialized
///         under v1 and re-delegated to v2 keeps its passkey, nonce, guard and
///         arise wiring with no re-initialization (see migration fork test).
///         execute / rotatePasskey / guard hook are byte-for-byte v1 semantics.
contract OndolAccountV2 {
    error AlreadyInitialized();
    error NotInitialized();
    error InvalidInitSignature();
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
    // MUST match v1 — migrated accounts read the same slots.
    bytes32 private constant STORAGE_SLOT =
        0x18e1b3a892f6ed7c2fcd36c56d51fd8e3976dafbc1e7e8cb81cf8ca8dca57c00;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant INIT_TYPEHASH =
        keccak256("Init(bytes32 x,bytes32 y,address guard,address arise)");

    /// @dev secp256k1 order / 2 — only low-s signatures accepted, matching the
    ///      malleability discipline on the P-256 side (WebAuthnP256).
    uint256 private constant SECP256K1_N_DIV_2 =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function _s() private pure returns (AccountStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }

    /// @notice One-time setup, submittable by anyone (the relayer pays gas);
    ///         authority is an EIP-712 signature from the EOA's own key. The
    ///         domain binds chainId AND verifyingContract, so a signature can
    ///         neither replay across chains nor onto any other account.
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
        // On a 7702 account address(this) is the EOA itself; ecrecover returns
        // address(0) on garbage, which can never equal a delegated account.
        if (recovered != address(this)) revert InvalidInitSignature();

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
    /// @param otpCode Optional one-time code for guard-gated transfers; "" when
    ///        no call needs one.
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

    /// @notice Swap the policy contract; only via self-call (an execute batch
    ///         targeting the account itself).
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
