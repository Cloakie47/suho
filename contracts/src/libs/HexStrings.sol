// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice String rendering helpers for OTP domain construction. The offchain
///         issuer must build byte-identical domain strings, so the formats are
///         fixed: addresses as 0x + 40 lowercase hex chars, bytes32 as 0x + 64
///         lowercase hex chars, amounts as unpadded decimal.
library HexStrings {
    bytes16 private constant HEX = "0123456789abcdef";

    function toHexString(address a) internal pure returns (string memory) {
        return _hex(abi.encodePacked(a));
    }

    function toHexString(bytes32 b) internal pure returns (string memory) {
        return _hex(abi.encodePacked(b));
    }

    function toDecimalString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v;
        uint256 len;
        while (tmp != 0) {
            len++;
            tmp /= 10;
        }
        bytes memory out = new bytes(len);
        while (v != 0) {
            out[--len] = HEX[v % 10];
            v /= 10;
        }
        return string(out);
    }

    function _hex(bytes memory data) private pure returns (string memory) {
        bytes memory out = new bytes(2 + data.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < data.length; i++) {
            out[2 + i * 2] = HEX[uint8(data[i]) >> 4];
            out[3 + i * 2] = HEX[uint8(data[i]) & 0x0f];
        }
        return string(out);
    }
}
