// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";
import {DojangConfig} from "../src/DojangConfig.sol";
import {IEAS, ISchemaRegistry, Attestation} from "../src/interfaces/IEAS.sol";

/// @dev Fork tests against the real EAS predeploy on GIWA Sepolia:
///      forge test --fork-url https://sepolia-rpc.giwa.io
contract SuhoCodeAttesterTest is Test {
    string internal constant SCHEMA = "bytes32 codeHash, string domain";

    address internal constant ALICE = address(0xA11CE);
    string internal constant DOMAIN_ARISE = "suho.arise:0xA11CE:0xdeadbeef";
    string internal constant DOMAIN_GUARD = "suho.guard:0xA11CE:0xB0B:bucket3";
    string internal constant CODE = "483920";

    SuhoCodeAttester internal attester;
    uint64 internal expiry;

    function setUp() public {
        // Register the Suho schema on the real SchemaRegistry; if some earlier run
        // (or third party) already registered this exact string/resolver/revocable
        // combination, fall back to its deterministic UID.
        bytes32 schemaUid;
        try ISchemaRegistry(DojangConfig.SCHEMA_REGISTRY).register(SCHEMA, address(0), true) returns (bytes32 uid) {
            schemaUid = uid;
        } catch {
            schemaUid = keccak256(abi.encodePacked(SCHEMA, address(0), true));
        }

        attester = new SuhoCodeAttester(IEAS(DojangConfig.EAS), schemaUid);
        expiry = uint64(block.timestamp + 10 minutes);
    }

    function _codeHash(address subject, string memory domain, string memory code) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(subject, domain, code));
    }

    function _issue(address subject, string memory domain, string memory code) internal returns (bytes32) {
        return attester.issueCode(subject, domain, _codeHash(subject, domain, code), expiry);
    }

    // ---- happy path ----

    function test_issueThenConsume() public {
        bytes32 uid = _issue(ALICE, DOMAIN_ARISE, CODE);

        assertTrue(uid != bytes32(0));
        assertTrue(attester.isCodeActive(ALICE, DOMAIN_ARISE));

        // Attestation really lives on the real EAS with the spec'd native fields.
        Attestation memory att = IEAS(DojangConfig.EAS).getAttestation(uid);
        assertEq(att.recipient, ALICE);
        assertEq(att.attester, address(attester));
        assertEq(att.expirationTime, expiry);

        assertTrue(attester.verifyAndConsume(ALICE, DOMAIN_ARISE, CODE));
        assertFalse(attester.isCodeActive(ALICE, DOMAIN_ARISE));
        assertTrue(attester.consumed(uid));
    }

    function test_consume_callableByAnyone() public {
        _issue(ALICE, DOMAIN_ARISE, CODE);
        vm.prank(address(0xBEEF));
        assertTrue(attester.verifyAndConsume(ALICE, DOMAIN_ARISE, CODE));
    }

    // ---- failure modes ----

    function test_reuse_revertsCodeAlreadyUsed() public {
        _issue(ALICE, DOMAIN_ARISE, CODE);
        attester.verifyAndConsume(ALICE, DOMAIN_ARISE, CODE);

        vm.expectRevert(SuhoCodeAttester.CodeAlreadyUsed.selector);
        attester.verifyAndConsume(ALICE, DOMAIN_ARISE, CODE);
    }

    function test_wrongCode_revertsCodeInvalid() public {
        _issue(ALICE, DOMAIN_ARISE, CODE);

        vm.expectRevert(SuhoCodeAttester.CodeInvalid.selector);
        attester.verifyAndConsume(ALICE, DOMAIN_ARISE, "000000");
    }

    function test_pastExpiry_revertsCodeExpired() public {
        _issue(ALICE, DOMAIN_ARISE, CODE);

        vm.warp(expiry + 1);
        vm.expectRevert(SuhoCodeAttester.CodeExpired.selector);
        attester.verifyAndConsume(ALICE, DOMAIN_ARISE, CODE);
    }

    function test_sameCodeDifferentDomain_revertsCodeInvalid() public {
        // A code observed in the mempool for one domain is useless against another:
        // codeHash binds (subject, domain, code), so replaying CODE from the arise
        // domain against the guard domain (which has its own active code) fails.
        _issue(ALICE, DOMAIN_ARISE, CODE);
        _issue(ALICE, DOMAIN_GUARD, "915662");

        vm.expectRevert(SuhoCodeAttester.CodeInvalid.selector);
        attester.verifyAndConsume(ALICE, DOMAIN_GUARD, CODE);
    }

    function test_noCode_revertsCodeNotFound() public {
        vm.expectRevert(SuhoCodeAttester.CodeNotFound.selector);
        attester.verifyAndConsume(ALICE, DOMAIN_ARISE, CODE);
    }

    // ---- re-issue / revoke ----

    function test_reissue_invalidatesOldCode() public {
        bytes32 oldUid = _issue(ALICE, DOMAIN_ARISE, CODE);
        bytes32 newUid = _issue(ALICE, DOMAIN_ARISE, "771204");
        assertTrue(oldUid != newUid);

        // Old attestation was revoked on EAS during the overwrite.
        Attestation memory oldAtt = IEAS(DojangConfig.EAS).getAttestation(oldUid);
        assertTrue(oldAtt.revocationTime != 0);

        // Old code no longer verifies; the new one does.
        vm.expectRevert(SuhoCodeAttester.CodeInvalid.selector);
        attester.verifyAndConsume(ALICE, DOMAIN_ARISE, CODE);

        assertTrue(attester.verifyAndConsume(ALICE, DOMAIN_ARISE, "771204"));
    }

    function test_revokeCode_clearsAndRevokesOnEAS() public {
        bytes32 uid = _issue(ALICE, DOMAIN_ARISE, CODE);
        attester.revokeCode(ALICE, DOMAIN_ARISE);

        assertFalse(attester.isCodeActive(ALICE, DOMAIN_ARISE));
        Attestation memory att = IEAS(DojangConfig.EAS).getAttestation(uid);
        assertTrue(att.revocationTime != 0);

        vm.expectRevert(SuhoCodeAttester.CodeNotFound.selector);
        attester.verifyAndConsume(ALICE, DOMAIN_ARISE, CODE);
    }

    // ---- access control ----

    function test_issueCode_onlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(SuhoCodeAttester.NotOwner.selector);
        attester.issueCode(ALICE, DOMAIN_ARISE, bytes32(uint256(1)), expiry);
    }

    function test_revokeCode_onlyOwner() public {
        _issue(ALICE, DOMAIN_ARISE, CODE);
        vm.prank(address(0xBEEF));
        vm.expectRevert(SuhoCodeAttester.NotOwner.selector);
        attester.revokeCode(ALICE, DOMAIN_ARISE);
    }
}
