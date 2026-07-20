// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SuhoCodeAttester} from "./SuhoCodeAttester.sol";
import {OndolAccount} from "./OndolAccount.sol";
import {HexStrings} from "./libs/HexStrings.sol";

/// @title AriseModule
/// @notice Passkey recovery. Callable by anyone (relayable): safety is entirely
///         the purpose-bound, single-use recovery code, whose domain commits to
///         both the account AND the hash of the new key — so a code minted for one
///         recovery cannot rotate in any other key or touch any other account.
contract AriseModule {
    using HexStrings for address;
    using HexStrings for bytes32;

    event Arisen(address indexed account, bytes32 newX, bytes32 newY);

    SuhoCodeAttester public immutable codes;

    constructor(SuhoCodeAttester _codes) {
        codes = _codes;
    }

    function arise(address account, bytes32 newX, bytes32 newY, string calldata code) external {
        string memory domain = string.concat(
            "suho.arise:",
            account.toHexString(),
            ":",
            keccak256(abi.encode(newX, newY)).toHexString()
        );
        // Single-use check: bubbles CodeNotFound / CodeInvalid / CodeExpired /
        // CodeAlreadyUsed. A domain built for a different (account, newKey) pair
        // simply has no active code, so tampering yields CodeNotFound.
        codes.verifyAndConsume(account, domain, code);

        OndolAccount(payable(account)).rotatePasskey(newX, newY);
        emit Arisen(account, newX, newY);
    }
}
