// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OndolTestBase} from "./OndolTestBase.sol";
import {OndolAccount} from "../src/OndolAccount.sol";
import {OndolAccountV2} from "../src/OndolAccountV2.sol";
import {Call} from "../src/interfaces/IOndolGuard.sol";
import {AriseModule} from "../src/AriseModule.sol";

/// @notice Phase O §O1 fork tests: signature-gated initialization for gasless,
///         non-custodial onboarding, plus the v1 -> v2 migration guarantee.
///         Fork: forge test --fork-url https://sepolia-rpc.giwa.io
contract OndolAccountV2Test is OndolTestBase {
    OndolAccountV2 internal impl2;

    address internal relayer2;

    function setUp() public override {
        super.setUp(); // full v1 stack: codes, guard, arise, delegated+initialized v1 account
        impl2 = new OndolAccountV2();
        relayer2 = makeAddr("v2-relayer");
        vm.deal(relayer2, 1 ether);
    }

    // ---- EIP-712 helper (mirrors the contract byte for byte) ----

    function _initDigest(
        address account_,
        bytes32 x,
        bytes32 y,
        address guard_,
        address arise_
    ) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Suho Ondol")),
                keccak256(bytes("2")),
                block.chainid,
                account_
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Init(bytes32 x,bytes32 y,address guard,address arise)"), x, y, guard_, arise_)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// @dev Fresh EOA delegated to the v2 impl. NO funding — the whole point.
    function _freshDelegated(string memory label) internal returns (address eoa, uint256 pk) {
        (eoa, pk) = makeAddrAndKey(label);
        vm.signAndAttachDelegation(address(impl2), pk);
        assertEq(eoa.balance, 0, "onboarding EOA must never need gas");
    }

    function _passkeyXY() internal view returns (bytes32 x, bytes32 y) {
        (uint256 px, uint256 py) = vm.publicKeyP256(PASSKEY_PK);
        return (bytes32(px), bytes32(py));
    }

    // ---- O1 required cases ----

    /// Relayer-submitted init: EOA holds zero gas; only its signature travels.
    function test_initWithSig_relayerSubmits_noEoaGas() public {
        (address eoa, uint256 pk) = _freshDelegated("onboard-eoa");
        (bytes32 x, bytes32 y) = _passkeyXY();

        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _initDigest(eoa, x, y, address(guard), address(arise)));

        vm.prank(relayer2); // relayer pays; EOA still has 0 ETH
        OndolAccountV2(payable(eoa)).initializeWithSig(x, y, address(guard), address(arise), v, r, s);

        assertTrue(OndolAccountV2(payable(eoa)).initialized());
        (bytes32 gx,) = OndolAccountV2(payable(eoa)).passkey();
        assertEq(gx, x);
        assertEq(OndolAccountV2(payable(eoa)).guard(), address(guard));
        assertEq(OndolAccountV2(payable(eoa)).ariseModule(), address(arise));
        assertEq(eoa.balance, 0, "EOA spent nothing");
    }

    /// Front-run: attacker races the relayer with their OWN passkey but cannot
    /// produce the EOA's signature — reverts, account stays claimable only by
    /// its owner.
    function test_initWithSig_frontRunInvalidSig_reverts() public {
        (address eoa,) = _freshDelegated("victim-eoa");
        (, uint256 attackerPk) = makeAddrAndKey("attacker");
        (uint256 ax, uint256 ay) = vm.publicKeyP256(PASSKEY2_PK); // attacker's passkey

        // attacker signs the digest with their key, not the EOA's
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            attackerPk,
            _initDigest(eoa, bytes32(ax), bytes32(ay), address(guard), address(arise))
        );

        vm.expectRevert(OndolAccountV2.InvalidInitSignature.selector);
        OndolAccountV2(payable(eoa)).initializeWithSig(
            bytes32(ax), bytes32(ay), address(guard), address(arise), v, r, s
        );
        assertFalse(OndolAccountV2(payable(eoa)).initialized());
    }

    /// Cross-account replay: a signature valid for account A recovers to A, not
    /// B — the digest binds verifyingContract, so it is worthless on B.
    function test_initWithSig_crossAccountReplay_reverts() public {
        (address eoaA, uint256 pkA) = _freshDelegated("replay-a");
        (address eoaB,) = _freshDelegated("replay-b");
        (bytes32 x, bytes32 y) = _passkeyXY();

        // A's own valid signature (over A's digest)
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pkA, _initDigest(eoaA, x, y, address(guard), address(arise)));

        // replayed onto B
        vm.expectRevert(OndolAccountV2.InvalidInitSignature.selector);
        OndolAccountV2(payable(eoaB)).initializeWithSig(x, y, address(guard), address(arise), v, r, s);

        // and B also rejects A's digest signed for B's ADDRESS by A's key
        (v, r, s) = vm.sign(pkA, _initDigest(eoaB, x, y, address(guard), address(arise)));
        vm.expectRevert(OndolAccountV2.InvalidInitSignature.selector);
        OndolAccountV2(payable(eoaB)).initializeWithSig(x, y, address(guard), address(arise), v, r, s);
    }

    /// Double-init: even a perfectly valid second signature reverts.
    function test_initWithSig_doubleInit_reverts() public {
        (address eoa, uint256 pk) = _freshDelegated("double-init");
        (bytes32 x, bytes32 y) = _passkeyXY();
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _initDigest(eoa, x, y, address(guard), address(arise)));
        OndolAccountV2(payable(eoa)).initializeWithSig(x, y, address(guard), address(arise), v, r, s);

        (uint256 px2, uint256 py2) = vm.publicKeyP256(PASSKEY2_PK);
        (v, r, s) = vm.sign(
            pk, _initDigest(eoa, bytes32(px2), bytes32(py2), address(guard), address(arise))
        );
        vm.expectRevert(OndolAccountV2.AlreadyInitialized.selector);
        OndolAccountV2(payable(eoa)).initializeWithSig(
            bytes32(px2), bytes32(py2), address(guard), address(arise), v, r, s
        );
    }

    /// v1 -> v2 migration (the alice case): an account initialized under v1,
    /// with live state (nonce, passkey, guard, arise), re-delegates to the v2
    /// implementation and keeps working with NO re-initialization — same
    /// ERC-7201 slots. execute() and the full arise rotation both function.
    function test_migration_v1StateSurvivesRedelegationToV2() public {
        // v1 account from the base fixture: initialized, funded, passkey set.
        _execute(_ethTransfer(VERIFIED_RECIPIENT, 0.1 ether), "", PASSKEY_PK);
        assertEq(OndolAccount(payable(account)).nonce(), 1);

        // re-delegate the SAME EOA to the v2 implementation
        vm.signAndAttachDelegation(address(impl2), accountEoaPk);
        assertEq(
            account.code, abi.encodePacked(hex"ef0100", address(impl2)), "designator now points at v2"
        );

        // state intact, no re-init needed (or possible)
        OndolAccountV2 acc = OndolAccountV2(payable(account));
        assertTrue(acc.initialized(), "initialized flag survived");
        assertEq(acc.nonce(), 1, "nonce survived");
        (bytes32 x,) = acc.passkey();
        (uint256 ex,) = vm.publicKeyP256(PASSKEY_PK);
        assertEq(x, bytes32(ex), "passkey survived");
        assertEq(acc.guard(), address(guard), "guard wiring survived");
        assertEq(acc.ariseModule(), address(arise), "arise wiring survived");

        // execute still works with the same passkey on v2
        uint256 before = VERIFIED_RECIPIENT.balance;
        _execute(_ethTransfer(VERIFIED_RECIPIENT, 0.1 ether), "", PASSKEY_PK);
        assertEq(VERIFIED_RECIPIENT.balance, before + 0.1 ether);
        assertEq(acc.nonce(), 2);

        // arise rotation still works on v2
        (uint256 nx, uint256 ny) = vm.publicKeyP256(PASSKEY2_PK);
        _issueAriseCode(bytes32(nx), bytes32(ny), "424242");
        vm.prank(relayer2);
        arise.arise(account, bytes32(nx), bytes32(ny), "424242");
        (bytes32 gx,) = acc.passkey();
        assertEq(gx, bytes32(nx), "arise rotated the passkey on v2");

        // and the old passkey is dead post-rotation
        Call[] memory calls = _ethTransfer(VERIFIED_RECIPIENT, 0.05 ether);
        bytes memory sig = _signWebAuthn(PASSKEY_PK, _challenge(calls));
        vm.prank(relayer);
        vm.expectRevert(OndolAccountV2.InvalidPasskeySignature.selector);
        acc.execute(calls, "", sig);

        // re-initialization is impossible on the migrated account
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            accountEoaPk,
            _initDigest(account, bytes32(ex), bytes32(ex), address(guard), address(arise))
        );
        vm.expectRevert(OndolAccountV2.AlreadyInitialized.selector);
        acc.initializeWithSig(bytes32(ex), bytes32(ex), address(guard), address(arise), v, r, s);
    }

    /// High-s (malleated) signature rejected even though ecrecover would
    /// accept its flipped twin — low-s discipline matches the P-256 side.
    function test_initWithSig_highS_reverts() public {
        (address eoa, uint256 pk) = _freshDelegated("high-s-eoa");
        (bytes32 x, bytes32 y) = _passkeyXY();
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _initDigest(eoa, x, y, address(guard), address(arise)));

        // malleate: s' = n - s, v' = flipped — the "other" valid signature
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sHigh = bytes32(N - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;

        vm.expectRevert(OndolAccountV2.InvalidInitSignature.selector);
        OndolAccountV2(payable(eoa)).initializeWithSig(x, y, address(guard), address(arise), vFlip, r, sHigh);
        assertFalse(OndolAccountV2(payable(eoa)).initialized());
    }

    /// Fresh v2 account end-to-end: init with sig, then a passkey-signed,
    /// guard-checked send — the full onboarding result in one test.
    function test_v2_executeAfterSigInit() public {
        (address eoa, uint256 pk) = _freshDelegated("fresh-sender");
        (bytes32 x, bytes32 y) = _passkeyXY();
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _initDigest(eoa, x, y, address(guard), address(arise)));
        vm.prank(relayer2);
        OndolAccountV2(payable(eoa)).initializeWithSig(x, y, address(guard), address(arise), v, r, s);

        vm.deal(eoa, 1 ether); // funding arrives AFTER onboarding (faucet step)
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: VERIFIED_RECIPIENT, value: 0.2 ether, data: ""});
        bytes32 challenge = keccak256(abi.encode(eoa, block.chainid, uint256(0), calls));
        bytes memory sig = _signWebAuthn(PASSKEY_PK, challenge);

        uint256 before = VERIFIED_RECIPIENT.balance;
        vm.prank(relayer2);
        OndolAccountV2(payable(eoa)).execute(calls, "", sig);
        assertEq(VERIFIED_RECIPIENT.balance, before + 0.2 ether);
        assertEq(OndolAccountV2(payable(eoa)).nonce(), 1);
    }
}
