// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    IEAS,
    Attestation,
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData
} from "./interfaces/IEAS.sol";

/// @title SuhoCodeAttester
/// @notice Suho's recovery/OTP attester. Issues one-time codes as attestations on the
///         real EAS under a Suho-owned schema shaped like Dojang's Verified Code
///         (`bytes32 codeHash, string domain`), so a future migration to the official
///         issuer is a schema-UID + attester swap.
///
///         Purpose binding lives in `domain`:
///           - recovery:      "suho.arise:<account>:<newSignerHash>"
///           - transfer OTPs: "suho.guard:<account>:<recipient>:<amountBucket>"
///         codeHash = keccak256(abi.encodePacked(subject, domain, code)), so a
///         mempool-observed code is useless for any other account/action.
contract SuhoCodeAttester {
    error NotOwner();
    error CodeNotFound();
    error CodeExpired();
    error CodeInvalid();
    error CodeAlreadyUsed();

    event CodeIssued(address indexed subject, bytes32 indexed domainHash, bytes32 uid, uint64 expiry);
    event CodeConsumed(address indexed subject, bytes32 indexed domainHash, bytes32 uid);
    event CodeRevoked(address indexed subject, bytes32 indexed domainHash, bytes32 uid);

    /// @notice Issuer service key.
    address public owner;

    IEAS public immutable eas;
    bytes32 public immutable schemaUid;

    /// @notice keccak256(subject, domainHash) => attestation uid of the active code.
    mapping(bytes32 => bytes32) public activeCode;

    /// @notice attestation uid => already used.
    mapping(bytes32 => bool) public consumed;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IEAS _eas, bytes32 _schemaUid) {
        owner = msg.sender;
        eas = _eas;
        schemaUid = _schemaUid;
    }

    /// @notice Attest a new one-time code for (subject, domain), overwriting and
    ///         revoking any prior active code for the same pair.
    function issueCode(address subject, string calldata domain, bytes32 codeHash, uint64 expiry)
        external
        onlyOwner
        returns (bytes32 uid)
    {
        bytes32 key = _codeKey(subject, domain);

        bytes32 prior = activeCode[key];
        if (prior != bytes32(0)) {
            _revoke(prior);
        }

        uid = eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: subject,
                    expirationTime: expiry,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode(codeHash, domain),
                    value: 0
                })
            })
        );

        activeCode[key] = uid;
        emit CodeIssued(subject, keccak256(bytes(domain)), uid, expiry);
    }

    /// @notice Verify a code and burn it. Callable by anyone; safety comes from the
    ///         domain binding inside codeHash, not caller identity.
    function verifyAndConsume(address subject, string calldata domain, string calldata code)
        external
        returns (bool)
    {
        bytes32 uid = activeCode[_codeKey(subject, domain)];
        if (uid == bytes32(0)) revert CodeNotFound();

        Attestation memory att = eas.getAttestation(uid);
        if (att.uid == bytes32(0) || att.revocationTime != 0) revert CodeNotFound();
        if (att.expirationTime <= block.timestamp) revert CodeExpired();
        if (consumed[uid]) revert CodeAlreadyUsed();

        (bytes32 storedCodeHash,) = abi.decode(att.data, (bytes32, string));
        if (keccak256(abi.encodePacked(subject, domain, code)) != storedCodeHash) revert CodeInvalid();

        consumed[uid] = true;
        emit CodeConsumed(subject, keccak256(bytes(domain)), uid);
        return true;
    }

    /// @notice Revoke the active code for (subject, domain) on EAS and clear the mapping.
    function revokeCode(address subject, string calldata domain) external onlyOwner {
        bytes32 key = _codeKey(subject, domain);
        bytes32 uid = activeCode[key];
        if (uid == bytes32(0)) revert CodeNotFound();

        _revoke(uid);
        delete activeCode[key];
        emit CodeRevoked(subject, keccak256(bytes(domain)), uid);
    }

    /// @notice True iff (subject, domain) has an unconsumed, unrevoked, unexpired code.
    function isCodeActive(address subject, string calldata domain) external view returns (bool) {
        bytes32 uid = activeCode[_codeKey(subject, domain)];
        if (uid == bytes32(0) || consumed[uid]) return false;

        Attestation memory att = eas.getAttestation(uid);
        return att.uid != bytes32(0) && att.revocationTime == 0 && att.expirationTime > block.timestamp;
    }

    function _codeKey(address subject, string calldata domain) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(subject, keccak256(bytes(domain))));
    }

    function _revoke(bytes32 uid) internal {
        // Only revoke attestations that are still live; EAS reverts on double-revoke.
        Attestation memory att = eas.getAttestation(uid);
        if (att.uid != bytes32(0) && att.revocationTime == 0) {
            eas.revoke(
                RevocationRequest({schema: schemaUid, data: RevocationRequestData({uid: uid, value: 0})})
            );
        }
    }
}
