// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title OndolProxy
/// @notice Phase G: the upgradeable 7702 delegation target. From now on an
///         account delegates to THIS proxy instead of straight to an
///         implementation, so its passkey can later move it to a new
///         implementation (OndolAccountV3.upgradeTo) without a new 7702
///         authorization — which onboarded users cannot produce, their EOA key
///         being destroyed. The proxy owns exactly one storage slot (the
///         ERC-1967 implementation pointer); every account field lives in the
///         ERC-7201 namespace the implementation owns and is never touched here.
///
///         Init authority is the account's own EOA key, one-time, as in V2. The
///         EOA signs WHICH implementation the proxy may install. This is not
///         decoration: EIP-7702 authorizations are replayable from the mempool,
///         so without it an attacker could re-attach the delegation and point
///         the account at a malicious implementation. With it, an auth-replay
///         attacker can neither choose the implementation (this signature) nor
///         initialize the real one with their own passkey (the implementation's
///         own init signature). After init, upgrades are gated to the passkey
///         alone. No admin, owner, or guardian — ever.
contract OndolProxy {
    error AlreadyInitialized();
    error InvalidInitSignature();
    error InitCallFailed(bytes returndata);

    event Upgraded(address indexed implementation);

    // ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1.
    // Deliberately OUTSIDE the suho.ondol.account ERC-7201 namespace.
    bytes32 private constant IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PROXY_INIT_TYPEHASH = keccak256("ProxyInit(address implementation)");

    /// @dev secp256k1 order / 2 — only low-s signatures, matching V2/V3.
    uint256 private constant SECP256K1_N_DIV_2 =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @notice One-time install of the implementation, authorized by an EIP-712
    ///         signature from the account's own key over the chosen impl. Anyone
    ///         may submit (the relayer pays gas). `initData`, when non-empty, is
    ///         delegatecalled into the implementation to run its own init (which
    ///         carries its own passkey signature). Empty `initData` is the
    ///         migration path for an account already initialized under V1/V2
    ///         (alice): set the slot only, leaving the live ERC-7201 state as is.
    function initialize(address implementation, bytes calldata initData, uint8 v, bytes32 r, bytes32 s)
        external
        payable
    {
        if (_implementation() != address(0)) revert AlreadyInitialized();
        if (uint256(s) > SECP256K1_N_DIV_2) revert InvalidInitSignature();

        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("Suho Ondol Proxy")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(abi.encode(PROXY_INIT_TYPEHASH, implementation));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        // On a 7702 account address(this) IS the EOA; ecrecover returns
        // address(0) on garbage, which can never equal a delegated account.
        if (ecrecover(digest, v, r, s) != address(this)) revert InvalidInitSignature();

        _setImplementation(implementation);
        emit Upgraded(implementation);

        if (initData.length > 0) {
            (bool ok, bytes memory ret) = implementation.delegatecall(initData);
            if (!ok) revert InitCallFailed(ret);
        }
    }

    /// @notice Everything else runs in the implementation's code at this
    ///         account's address and storage.
    fallback() external payable {
        address impl = _implementation();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}

    function _implementation() private view returns (address impl) {
        assembly {
            impl := sload(IMPL_SLOT)
        }
    }

    function _setImplementation(address impl) private {
        assembly {
            sstore(IMPL_SLOT, impl)
        }
    }
}
