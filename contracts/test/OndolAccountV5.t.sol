// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OndolTestBase} from "./OndolTestBase.sol";
import {OndolAccountV4} from "../src/OndolAccountV4.sol";
import {OndolAccountV5} from "../src/OndolAccountV5.sol";
import {OndolProxy} from "../src/OndolProxy.sol";
import {HexStrings} from "../src/libs/HexStrings.sol";
import {WebAuthnP256} from "../src/libs/WebAuthnP256.sol";
import {Call} from "../src/interfaces/IOndolGuard.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";

/// @notice Horizon 1 / S1.1 fork tests: OndolAccountV5 ERC-1271.
///         Serial only: forge test --fork-url https://sepolia-rpc.giwa.io -j 1
///
///         V5 = V4 + isValidSignature. These tests prove the view: a valid current
///         passkey signature returns the magic value; a wrong key, a rotated-out
///         (post-Arise) key, and a malleable high-s signature all fail; the V4->V5
///         upgrade path works on a live proxy account; and the view reads the same
///         live pubkey slot as execute (no storage collision) across the packed
///         lock writes and a rotation. The full V4 gate is re-exercised through the
///         inherited execute in OndolAccountV4.t.sol; here we exercise only the new
///         surface plus the migration/collision invariants S1.1 calls out.
contract OndolAccountV5Test is OndolTestBase {
    using HexStrings for address;
    using HexStrings for bytes32;

    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant FAIL = 0xffffffff;

    OndolAccountV4 internal implV4;
    OndolAccountV5 internal implV5;
    OndolProxy internal proxyImpl;
    address internal relayer5;

    address internal acct; // a V5-native proxy account
    uint256 internal acctPk;

    function setUp() public override {
        super.setUp();
        implV4 = new OndolAccountV4(codes);
        implV5 = new OndolAccountV5(codes);
        proxyImpl = new OndolProxy();
        relayer5 = makeAddr("v5-relayer");
        vm.deal(relayer5, 1 ether);
        (acct, acctPk) = _newProxyAccount("v5-acct", address(implV5));
        vm.deal(acct, 10 ether);
    }

    // ---- proxy account + execute helpers (mirror the V4 test, generic on impl) ----

    function _initDigest(address a, bytes32 x, bytes32 y, address g, address ar) internal view returns (bytes32) {
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Suho Ondol")),
                keccak256(bytes("2")),
                block.chainid,
                a
            )
        );
        bytes32 sh =
            keccak256(abi.encode(keccak256("Init(bytes32 x,bytes32 y,address guard,address arise)"), x, y, g, ar));
        return keccak256(abi.encodePacked("\x19\x01", ds, sh));
    }

    function _proxyInitDigest(address a, address impl_) internal view returns (bytes32) {
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Suho Ondol Proxy")),
                keccak256(bytes("1")),
                block.chainid,
                a
            )
        );
        bytes32 sh = keccak256(abi.encode(keccak256("ProxyInit(address implementation)"), impl_));
        return keccak256(abi.encodePacked("\x19\x01", ds, sh));
    }

    /// @dev A fresh 7702 proxy account initialized behind `impl_` (V4 or V5) with
    ///      the PASSKEY_PK passkey. Returns the account address and its EOA key.
    function _newProxyAccount(string memory label, address impl_) internal returns (address eoa, uint256 pk) {
        (eoa, pk) = makeAddrAndKey(label);
        vm.signAndAttachDelegation(address(proxyImpl), pk);
        // Scoped blocks keep the stack shallow (init sig + proxy sig otherwise
        // exceed the 16-slot limit alongside eoa/pk/impl_).
        bytes memory initData;
        {
            (uint256 x, uint256 y) = vm.publicKeyP256(PASSKEY_PK);
            (uint8 iv, bytes32 ir, bytes32 is_) =
                vm.sign(pk, _initDigest(eoa, bytes32(x), bytes32(y), address(guard), address(arise)));
            initData = abi.encodeCall(
                OndolAccountV4.initializeWithSig, (bytes32(x), bytes32(y), address(guard), address(arise), iv, ir, is_)
            );
        }
        {
            (uint8 pv, bytes32 pr, bytes32 ps) = vm.sign(pk, _proxyInitDigest(eoa, impl_));
            vm.prank(relayer5);
            OndolProxy(payable(eoa)).initialize(impl_, initData, pv, pr, ps);
        }
        assertTrue(OndolAccountV4(payable(eoa)).initialized(), "initialized behind proxy");
    }

    function _challengeFor(address a, Call[] memory calls, uint256 maxGas) internal view returns (bytes32) {
        return keccak256(abi.encode(a, block.chainid, OndolAccountV4(payable(a)).nonce(), calls, maxGas));
    }

    /// @dev Sign over `a`'s current nonce with `pk` and relay the batch through `a`.
    function _execFor(address a, Call[] memory calls, string memory otp, uint256 pk) internal {
        bytes memory sig = _signWebAuthn(pk, _challengeFor(a, calls, 0));
        vm.prank(relayer5);
        OndolAccountV4(payable(a)).execute(calls, otp, 0, sig);
    }

    function _callTo(address target, uint256 value, bytes memory data) internal pure returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call({target: target, value: value, data: data});
    }

    /// @dev A WebAuthn assertion that keeps HIGH-s (the malleable counterpart), to
    ///      prove the verifier's low-s policy is enforced through isValidSignature.
    ///      Mirrors _signWebAuthn but flips s to N - s whenever it came out low.
    function _signWebAuthnHighS(uint256 pk, bytes32 challenge) internal pure returns (bytes memory) {
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            string(WebAuthnP256._base64Url(challenge)),
            '","origin":"https://suho.app"}'
        );
        bytes memory authData = abi.encodePacked(bytes32(uint256(0xdead)), bytes1(0x05), uint32(0));
        bytes32 digest = sha256(bytes.concat(authData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
        uint256 sHigh = uint256(s);
        if (sHigh <= WebAuthnP256.P256_N_DIV_2) sHigh = WebAuthnP256.P256_N - sHigh; // force high-s
        return abi.encode(WebAuthnP256.WebAuthnAuth(authData, clientDataJSON, 23, 1, uint256(r), sHigh));
    }

    function _v5() internal view returns (OndolAccountV5) {
        return OndolAccountV5(payable(acct));
    }

    // =================== 1. ERC-1271 core ===================

    function test_1271_validCurrentKey_returnsMagic() public {
        bytes32 hash = keccak256("suhoswap.xyz wants to sign you in");
        bytes memory sig = _signWebAuthn(PASSKEY_PK, hash);
        assertEq(_v5().isValidSignature(hash, sig), MAGIC, "valid current-key signature returns the magic value");
    }

    function test_1271_wrongKey_rejects() public {
        bytes32 hash = keccak256("sign in");
        // Signed by a key the account does NOT hold.
        bytes memory sig = _signWebAuthn(PASSKEY2_PK, hash);
        assertEq(_v5().isValidSignature(hash, sig), FAIL, "wrong-key signature is rejected");
    }

    function test_1271_wrongHash_rejects() public {
        // A signature over hashA must not validate hashB (no cross-message reuse).
        bytes32 hashA = keccak256("message A");
        bytes32 hashB = keccak256("message B");
        bytes memory sig = _signWebAuthn(PASSKEY_PK, hashA);
        assertEq(_v5().isValidSignature(hashB, sig), FAIL, "signature bound to its own hash only");
    }

    function test_1271_highS_rejects() public {
        // Malleable high-s signature by the CURRENT key must still fail (low-s only).
        bytes32 hash = keccak256("malleable");
        bytes memory sig = _signWebAuthnHighS(PASSKEY_PK, hash);
        assertEq(_v5().isValidSignature(hash, sig), FAIL, "high-s signature rejected by the low-s policy");
    }

    function test_1271_garbageSignature_rejects() public view {
        // Non-decodable / empty signature must fail closed, not revert.
        assertEq(_v5().isValidSignature(keccak256("x"), hex""), FAIL, "empty signature fails closed");
    }

    // =================== 2. rotation (Arise) invalidates old keys ===================

    function test_1271_postArise_oldKeyRejects_newKeyValidates() public {
        bytes32 hash = keccak256("post-rotation sign-in");
        // Old key validates before rotation.
        assertEq(_v5().isValidSignature(hash, _signWebAuthn(PASSKEY_PK, hash)), MAGIC, "old key valid pre-rotation");

        // Rotate to PASSKEY2 through the AriseModule (a code bound to account+newkey).
        (uint256 nx, uint256 ny) = vm.publicKeyP256(PASSKEY2_PK);
        string memory domain = string.concat(
            "suho.arise:", acct.toHexString(), ":", keccak256(abi.encode(bytes32(nx), bytes32(ny))).toHexString()
        );
        codes.issueCode(
            acct, domain, keccak256(abi.encodePacked(acct, domain, "654321")), uint64(block.timestamp + 10 minutes)
        );
        arise.arise(acct, bytes32(nx), bytes32(ny), "654321");

        // Old-key signature no longer validates; new-key signature does.
        assertEq(_v5().isValidSignature(hash, _signWebAuthn(PASSKEY_PK, hash)), FAIL, "rotated-out key rejected");
        assertEq(_v5().isValidSignature(hash, _signWebAuthn(PASSKEY2_PK, hash)), MAGIC, "new key validates");
    }

    // =================== 3. V4 -> V5 upgrade path on a live proxy account ===================

    function test_v4ToV5_upgradePath_enablesIsValidSignature() public {
        // A V4 proxy account with no ERC-1271 surface.
        (address v4acct,) = _newProxyAccount("v4-legacy", address(implV4));
        vm.deal(v4acct, 1 ether);
        assertEq(OndolAccountV4(payable(v4acct)).implementation(), address(implV4), "starts on V4");

        // Before upgrade, isValidSignature is not part of V4: staticcall reverts.
        bytes32 hash = keccak256("upgrade then sign");
        (bool okBefore,) = v4acct.staticcall(abi.encodeWithSelector(MAGIC, hash, _signWebAuthn(PASSKEY_PK, hash)));
        assertFalse(okBefore, "V4 has no isValidSignature");

        // Passkey-authorized upgradeTo V5 (account unlocked, so empty code).
        _execFor(
            v4acct, _callTo(v4acct, 0, abi.encodeCall(OndolAccountV4.upgradeTo, (address(implV5), ""))), "", PASSKEY_PK
        );
        assertEq(OndolAccountV4(payable(v4acct)).implementation(), address(implV5), "now on V5");

        // The same passkey now signs in via ERC-1271; V4 state carried over intact.
        assertEq(
            OndolAccountV5(payable(v4acct)).isValidSignature(hash, _signWebAuthn(PASSKEY_PK, hash)),
            MAGIC,
            "1271 live after upgrade"
        );
        assertEq(OndolAccountV4(payable(v4acct)).guard(), address(guard), "guard preserved across upgrade");
        assertTrue(OndolAccountV4(payable(v4acct)).initialized(), "initialized preserved across upgrade");
    }

    // =================== 4. runtime storage-collision ===================

    /// The view must read the SAME live pubkey slot as execute()/passkey(), and the
    /// packed lock writes must not disturb it. Enable both locks (which write the
    /// final packed word alongside initialized/ariseModule), then confirm the key,
    /// the V4 fields, and isValidSignature are all still correct.
    function test_v5_storageLayout_noCollision() public {
        (bytes32 kx, bytes32 ky) = _v5().passkey();
        address g0 = _v5().guard();
        address a0 = _v5().ariseModule();

        bytes32 hash = keccak256("collision probe");
        assertEq(_v5().isValidSignature(hash, _signWebAuthn(PASSKEY_PK, hash)), MAGIC, "valid before lock writes");

        // Packed writes: both bool locks live in the same word as initialized/arise.
        _execFor(acct, _callTo(acct, 0, abi.encodeCall(OndolAccountV4.enableSensitiveOpLock, ())), "", PASSKEY_PK);
        _execFor(acct, _callTo(acct, 0, abi.encodeCall(OndolAccountV4.enableEmailLargeSendLock, ())), "", PASSKEY_PK);

        (bytes32 kx2, bytes32 ky2) = _v5().passkey();
        assertEq(kx2, kx, "pubKeyX unchanged after packed writes");
        assertEq(ky2, ky, "pubKeyY unchanged after packed writes");
        assertEq(_v5().guard(), g0, "guard unchanged");
        assertEq(_v5().ariseModule(), a0, "ariseModule unchanged");
        assertTrue(_v5().sensitiveOpLock() && _v5().emailLargeSendLock(), "both locks engaged");
        // The view still reads the same live key slot after the packed writes.
        assertEq(
            _v5().isValidSignature(hash, _signWebAuthn(PASSKEY_PK, hash)),
            MAGIC,
            "valid after lock writes (no collision)"
        );
    }

    /// isValidSignature and execute must agree on which key is live: after a
    /// rotation, the same key that execute now requires is the one 1271 accepts.
    function test_v5_viewAndExecuteShareTheKeySlot() public {
        // Rotate to PASSKEY2, then a PASSKEY2-signed execute succeeds AND a
        // PASSKEY2-signed 1271 validates — same slot, same key.
        (uint256 nx, uint256 ny) = vm.publicKeyP256(PASSKEY2_PK);
        string memory domain = string.concat(
            "suho.arise:", acct.toHexString(), ":", keccak256(abi.encode(bytes32(nx), bytes32(ny))).toHexString()
        );
        codes.issueCode(
            acct, domain, keccak256(abi.encodePacked(acct, domain, "111111")), uint64(block.timestamp + 10 minutes)
        );
        arise.arise(acct, bytes32(nx), bytes32(ny), "111111");

        uint256 before = unverified.balance;
        _execFor(acct, _callTo(unverified, 0.001 ether, ""), "", PASSKEY2_PK);
        assertEq(unverified.balance, before + 0.001 ether, "execute now requires the rotated key");

        bytes32 hash = keccak256("shared slot");
        assertEq(
            _v5().isValidSignature(hash, _signWebAuthn(PASSKEY2_PK, hash)), MAGIC, "1271 accepts the same rotated key"
        );
    }
}
