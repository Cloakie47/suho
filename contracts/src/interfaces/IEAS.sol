// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal subset of the Ethereum Attestation Service interface used by Suho:
///         attest, revoke, getAttestation, plus the schema registry's register.
///         Struct layouts are byte-identical to the canonical EAS contracts
///         deployed as OP-stack predeploys on GIWA Sepolia.

struct AttestationRequestData {
    address recipient;
    uint64 expirationTime;
    bool revocable;
    bytes32 refUID;
    bytes data;
    uint256 value;
}

struct AttestationRequest {
    bytes32 schema;
    AttestationRequestData data;
}

struct RevocationRequestData {
    bytes32 uid;
    uint256 value;
}

struct RevocationRequest {
    bytes32 schema;
    RevocationRequestData data;
}

struct Attestation {
    bytes32 uid;
    bytes32 schema;
    uint64 time;
    uint64 expirationTime;
    uint64 revocationTime;
    bytes32 refUID;
    address recipient;
    address attester;
    bool revocable;
    bytes data;
}

interface IEAS {
    function attest(AttestationRequest calldata request) external payable returns (bytes32);
    function revoke(RevocationRequest calldata request) external payable;
    function getAttestation(bytes32 uid) external view returns (Attestation memory);
}

interface ISchemaRegistry {
    /// @dev resolver is typed as address (not ISchemaResolver) to keep this interface
    ///      dependency-free; the ABI encoding is identical.
    function register(string calldata schema, address resolver, bool revocable) external returns (bytes32);
}
