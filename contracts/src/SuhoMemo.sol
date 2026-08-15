// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SuhoMemo
/// @notice Minimal on-chain memo log. A memo is a short, PUBLIC note attached to
///         a payment: the sender appends a `note(recipient, text)` call to the
///         SAME execute() batch as the transfer, so the memo and the money land
///         in one atomic, passkey-authorized transaction. Nothing is stored in
///         state — the memo lives only as an indexed event, cheap to emit and
///         easy to read back by `from`/`to`.
///
///         Memos are public by design (they are chain events); the app says so at
///         the point of entry. The 140-character cap matches the app's field.
contract SuhoMemo {
    /// @param from The account that sent the payment (msg.sender here).
    /// @param to   The payment recipient the note is addressed to.
    /// @param text The note (<= 140 bytes).
    event Memo(address indexed from, address indexed to, string text);

    error MemoTooLong();

    /// @notice Emit a memo. Reverts if `text` exceeds 140 bytes so a batched
    ///         send can never carry an oversized note (belt-and-suspenders with
    ///         the app's own limit).
    function note(address to, string calldata text) external {
        if (bytes(text).length > 140) revert MemoTooLong();
        emit Memo(msg.sender, to, text);
    }
}
