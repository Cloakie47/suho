// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OndolAccountV4} from "./OndolAccountV4.sol";
import {IERC1271} from "./interfaces/IERC1271.sol";
import {WebAuthnP256} from "./libs/WebAuthnP256.sol";
import {SuhoCodeAttester} from "./SuhoCodeAttester.sol";

/// @title OndolAccountV5
/// @notice Horizon 1 / S1.1: ERC-1271 signature validation, so a dApp can ask this
///         account to sign in (SIWE), sign a message (personal_sign), or sign typed
///         data (EIP-712) and verify it on-chain. This is the contract half of the
///         Ondol SDK; the signing UI lives in the Suho-origin /connect popup.
///
///         V5 IS V4 PLUS ONE VIEW FUNCTION. Everything else — execute, the capped
///         gas reimbursement, initializeWithSig, the guard hook, rotatePasskey,
///         upgradeTo, the two opt-in email locks (sensitiveOpLock,
///         emailLargeSendLock), and the low-s discipline — is inherited byte-for-byte
///         from V4, so the audited V4 behaviour is provably unchanged. V5 adds no
///         state variable and no new authority; it only reads.
///
///         isValidSignature verifies a WebAuthn P-256 assertion by the account's
///         CURRENT passkey over `hash`, through the exact same verifier and low-s
///         policy as execute() (WebAuthnP256.verify -> RIP-7212 P256VERIFY,
///         malleable high-s rejected). Because it reads the live pubkey slot,
///         rotation via Arise automatically invalidates old-key signatures: a
///         signature from a rotated-out key stops validating the instant the key
///         changes.
///
///         Replay scope: ERC-1271 attests only that the current key signed THIS
///         hash. Binding the hash to a specific intent is the caller's job — SIWE
///         messages carry domain + nonce + expiry, EIP-712 typed data carries a
///         domain separator. The account intentionally adds no nonce of its own: a
///         signature is a statement, not a state transition, and a stateful nonce
///         here would break legitimate multi-verify flows. This matches the
///         ERC-1271 contract and how Coinbase/OZ smart-account signers behave.
///
///         Storage: NONE added. Same ERC-7201 namespace as V1..V4. STORAGE_SLOT
///         below MUST equal V4's; it is re-declared (not reached through V4's
///         private accessor) purely so this file reads standalone. The runtime
///         storage-collision test proves isValidSignature reads the same live
///         pubkey slot as execute()/passkey(), before and after the packed lock
///         writes and a key rotation.
contract OndolAccountV5 is OndolAccountV4, IERC1271 {
    /// @dev bytes4(keccak256("isValidSignature(bytes32,bytes)")).
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 private constant ERC1271_FAIL = 0xffffffff;

    // MUST equal the slot in OndolAccountV1..V4: migrated accounts read the same
    // ERC-7201 struct. keccak256(abi.encode(uint256(keccak256("suho.ondol.account"))
    // - 1)) & ~bytes32(uint256(0xff)).
    bytes32 private constant STORAGE_SLOT = 0x18e1b3a892f6ed7c2fcd36c56d51fd8e3976dafbc1e7e8cb81cf8ca8dca57c00;

    constructor(SuhoCodeAttester _codeAttester) OndolAccountV4(_codeAttester) {}

    function _sv5() private pure returns (AccountStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }

    /// @notice EIP-1271: returns the magic value iff `signature` is a valid WebAuthn
    ///         assertion by the account's current passkey over `hash`. FAILS CLOSED
    ///         and never reverts — a wrong key, a malleable high-s, or malformed
    ///         signature bytes all return 0xffffffff, so SIWE verifiers and OZ
    ///         SignatureChecker branch cleanly. The decode+verify runs behind a
    ///         staticcall to self so an undecodable blob is caught, not bubbled.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        try this.verifyPasskeySignature(hash, signature) returns (bool ok) {
            return ok ? ERC1271_MAGIC : ERC1271_FAIL;
        } catch {
            return ERC1271_FAIL;
        }
    }

    /// @dev Decode + verify the WebAuthn assertion against the live passkey. External
    ///      so isValidSignature can wrap it in try/catch, but self-only: it is an
    ///      implementation detail of isValidSignature, not a second public surface.
    ///      A malformed `signature` reverts in abi.decode here and is caught above.
    function verifyPasskeySignature(bytes32 hash, bytes calldata signature) external view returns (bool) {
        if (msg.sender != address(this)) revert NotSelf();
        AccountStorage storage $ = _sv5();
        return WebAuthnP256.verify(hash, signature, $.pubKeyX, $.pubKeyY);
    }
}
