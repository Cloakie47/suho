// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal-but-correct WebAuthn assertion verification over the RIP-7212
///         P256VERIFY precompile (live at 0x...0100 on GIWA Sepolia, probe-verified).
///
///         Verification approach adapted from daimo-eth/p256-verifier (WebAuthn.sol)
///         and base-org/webauthn-sol: caller-supplied indices locate the `type` and
///         `challenge` properties inside clientDataJSON so no JSON parsing happens
///         onchain; the checks performed are the WebAuthn spec's required verification
///         steps 11 (type), 12 (challenge), and 16 (user-presence flag), plus the
///         signature itself over sha256(authenticatorData || sha256(clientDataJSON)).
///
///         Deliberately NOT checked (per those references, single-origin wallet use):
///         origin, rpIdHash, backup-state flags, and the signature counter.
library WebAuthnP256 {
    /// @dev RIP-7212 precompile address.
    address internal constant P256_VERIFIER = 0x0000000000000000000000000000000000000100;

    /// @dev P-256 curve order n and n/2, for signature malleability rejection
    ///      (same policy as daimo-eth/p256-verifier: only low-s accepted).
    uint256 internal constant P256_N =
        0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    uint256 internal constant P256_N_DIV_2 = P256_N / 2;

    /// @notice A WebAuthn authentication assertion, ABI-encoded as the account's
    ///         signature blob.
    struct WebAuthnAuth {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex; // byte offset of '"challenge":"..."' in clientDataJSON
        uint256 typeIndex; // byte offset of '"type":"webauthn.get"' in clientDataJSON
        uint256 r;
        uint256 s;
    }

    bytes private constant EXPECTED_TYPE = bytes('"type":"webauthn.get"');

    function verify(bytes32 challenge, bytes memory encodedAuth, bytes32 pubKeyX, bytes32 pubKeyY)
        internal
        view
        returns (bool)
    {
        WebAuthnAuth memory auth = abi.decode(encodedAuth, (WebAuthnAuth));

        // 16. authenticatorData: minimum length (32-byte rpIdHash + flags + counter)
        //     and user-presence flag (bit 0 of the flags byte) set.
        if (auth.authenticatorData.length < 37) return false;
        if (auth.authenticatorData[32] & 0x01 != 0x01) return false;

        bytes memory clientData = bytes(auth.clientDataJSON);

        // 11. type check.
        if (!_matches(clientData, auth.typeIndex, EXPECTED_TYPE)) return false;

        // 12. challenge check: clientDataJSON must embed base64url(challenge).
        bytes memory expectedChallenge =
            bytes.concat('"challenge":"', _base64Url(challenge), '"');
        if (!_matches(clientData, auth.challengeIndex, expectedChallenge)) return false;

        // Reject malleable signatures.
        if (auth.s > P256_N_DIV_2) return false;

        // Signature message per WebAuthn: authenticatorData || sha256(clientDataJSON).
        bytes32 message = sha256(bytes.concat(auth.authenticatorData, sha256(clientData)));

        // RIP-7212 input: hash || r || s || x || y (160 bytes); output: 32-byte 1 or empty.
        (bool ok, bytes memory ret) =
            P256_VERIFIER.staticcall(abi.encode(message, auth.r, auth.s, pubKeyX, pubKeyY));
        return ok && ret.length == 32 && bytes32(ret) == bytes32(uint256(1));
    }

    /// @dev Compare `pattern` against `data[start .. start+pattern.length)`.
    function _matches(bytes memory data, uint256 start, bytes memory pattern)
        private
        pure
        returns (bool)
    {
        if (start + pattern.length > data.length) return false;
        for (uint256 i = 0; i < pattern.length; i++) {
            if (data[start + i] != pattern[i]) return false;
        }
        return true;
    }

    /// @dev base64url (RFC 4648 §5, no padding) of a 32-byte value: always 43 chars.
    function _base64Url(bytes32 input) internal pure returns (bytes memory out) {
        bytes memory alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        out = new bytes(43);
        uint256 bits;
        uint256 bitCount;
        uint256 j;
        for (uint256 i = 0; i < 32; i++) {
            bits = (bits << 8) | uint8(input[i]);
            bitCount += 8;
            while (bitCount >= 6) {
                bitCount -= 6;
                out[j++] = alphabet[(bits >> bitCount) & 0x3f];
            }
        }
        // 256 bits = 42 full 6-bit groups + 4 remaining bits, left-padded into a final char.
        out[j] = alphabet[(bits << (6 - bitCount)) & 0x3f];
    }
}
