// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DojangConfig} from "../src/DojangConfig.sol";
import {IDojangScroll} from "../src/interfaces/IDojangScroll.sol";
import {IEAS, ISchemaRegistry} from "../src/interfaces/IEAS.sol";
import {Call} from "../src/interfaces/IOndolGuard.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";
import {OndolAccount} from "../src/OndolAccount.sol";
import {OndolTransferGuard} from "../src/OndolTransferGuard.sol";
import {AriseModule} from "../src/AriseModule.sol";
import {WebAuthnP256} from "../src/libs/WebAuthnP256.sol";
import {HexStrings} from "../src/libs/HexStrings.sol";

/// @notice Shared fixture for the Ondol fork tests. Creates the full stack
///         (attester, guard, arise, account implementation) and one 7702-delegated,
///         initialized account backed by a vm-generated EOA key — NEVER a real
///         demo-wallet key (spec §6).
abstract contract OndolTestBase is Test {
    using HexStrings for address;
    using HexStrings for uint256;
    using HexStrings for bytes32;

    string internal constant SCHEMA = "bytes32 codeHash, string domain";
    uint256 internal constant OTP_THRESHOLD = 0.01 ether;

    // Playground-verified wallet, reused from DojangRead.t.sol as the verified
    // recipient on fork. (This is the brand wallet, not alice.)
    address internal constant VERIFIED_RECIPIENT = 0x23f76916A462adC7583E31e8b4650d51De437eE2;

    // vm.signP256 passkey scalars (any value < curve order n works).
    uint256 internal constant PASSKEY_PK = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 internal constant PASSKEY2_PK = 0x2222222222222222222222222222222222222222222222222222222222222222;

    SuhoCodeAttester internal codes;
    OndolTransferGuard internal guard;
    AriseModule internal arise;
    OndolAccount internal impl;

    address internal account; // the 7702-delegated EOA (vm-generated)
    uint256 internal accountEoaPk;
    address internal relayer;
    address internal unverified; // fresh, never touches Dojang

    function setUp() public virtual {
        bytes32 schemaUid;
        try ISchemaRegistry(DojangConfig.SCHEMA_REGISTRY).register(SCHEMA, address(0), true) returns (bytes32 uid) {
            schemaUid = uid;
        } catch {
            schemaUid = keccak256(abi.encodePacked(SCHEMA, address(0), true));
        }
        codes = new SuhoCodeAttester(IEAS(DojangConfig.EAS), schemaUid);

        guard = new OndolTransferGuard(
            IDojangScroll(DojangConfig.DOJANG_SCROLL),
            DojangConfig.acceptedAttesterIds(),
            OTP_THRESHOLD,
            codes
        );
        arise = new AriseModule(codes);
        impl = new OndolAccount();

        (account, accountEoaPk) = makeAddrAndKey("ondol-eoa");
        relayer = makeAddr("relayer");
        unverified = makeAddr("unverified-recipient");

        // 7702 delegation. In-test the cheatcode signs with the EOA's CURRENT
        // nonce because no transaction from the EOA precedes the attachment. On
        // the live chain via `cast wallet sign-auth`, a SELF-submitted type-4 tx
        // must sign the authorization with nonce + 1 instead — the tx consumes
        // the current nonce before the authorization list is processed
        // (empirically confirmed in the Phase-0 probe).
        vm.signAndAttachDelegation(address(impl), accountEoaPk);
        assertEq(account.code.length, 23, "delegation designator should be 23 bytes");

        // Initialize via self-call: the delegated EOA calls its own address.
        (uint256 x, uint256 y) = vm.publicKeyP256(PASSKEY_PK);
        vm.prank(account);
        OndolAccount(payable(account)).initialize(bytes32(x), bytes32(y), address(guard), address(arise));

        vm.deal(account, 1 ether);
        vm.deal(relayer, 1 ether);
    }

    // ---- helpers ----

    /// @dev Builds a WebAuthn assertion over `challenge`, signed by P-256 key `pk`.
    ///      Layout mirrors what a real authenticator produces; indices point at the
    ///      type (1) and challenge (23) properties of this fixed clientDataJSON shape.
    function _signWebAuthn(uint256 pk, bytes32 challenge) internal pure returns (bytes memory) {
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            string(WebAuthnP256._base64Url(challenge)),
            '","origin":"https://suho.app"}'
        );
        // rpIdHash (32) || flags (UP|UV = 0x05) || signCount (4)
        bytes memory authData = abi.encodePacked(bytes32(uint256(0xdead)), bytes1(0x05), uint32(0));
        bytes32 digest = sha256(bytes.concat(authData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);

        // The onchain verifier (like daimo's) only accepts low-s signatures.
        uint256 sNorm = uint256(s);
        if (sNorm > WebAuthnP256.P256_N_DIV_2) sNorm = WebAuthnP256.P256_N - sNorm;

        return abi.encode(WebAuthnP256.WebAuthnAuth(authData, clientDataJSON, 23, 1, uint256(r), sNorm));
    }

    function _challenge(Call[] memory calls) internal view returns (bytes32) {
        return keccak256(
            abi.encode(account, block.chainid, OndolAccount(payable(account)).nonce(), calls)
        );
    }

    /// @dev Sign with `pk` over the account's current nonce and relay the batch.
    function _execute(Call[] memory calls, string memory otp, uint256 pk) internal {
        bytes memory sig = _signWebAuthn(pk, _challenge(calls));
        vm.prank(relayer);
        OndolAccount(payable(account)).execute(calls, otp, sig);
    }

    function _ethTransfer(address to, uint256 amount) internal pure returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call({target: to, value: amount, data: ""});
    }

    /// @dev Issues a guard OTP for a large transfer, byte-identical to the domain
    ///      OndolTransferGuard constructs.
    function _issueGuardOtp(address recipient, uint256 value, string memory code) internal {
        string memory domain = string.concat(
            "suho.guard:", account.toHexString(), ":", recipient.toHexString(), ":", value.toDecimalString()
        );
        codes.issueCode(
            account,
            domain,
            keccak256(abi.encodePacked(account, domain, code)),
            uint64(block.timestamp + 10 minutes)
        );
    }

    /// @dev Issues an arise recovery code committing to (account, new pubkey).
    function _issueAriseCode(bytes32 newX, bytes32 newY, string memory code) internal {
        string memory domain = string.concat(
            "suho.arise:", account.toHexString(), ":", keccak256(abi.encode(newX, newY)).toHexString()
        );
        codes.issueCode(
            account,
            domain,
            keccak256(abi.encodePacked(account, domain, code)),
            uint64(block.timestamp + 10 minutes)
        );
    }
}
