// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Call, Verdict, IOndolTransferGuard} from "./interfaces/IOndolGuard.sol";
import {SuhoCodeAttester} from "./SuhoCodeAttester.sol";
import {HexStrings} from "./libs/HexStrings.sol";

/// @title OndolSpendingGuard
/// @notice The bank model. A payment is authorized by the OWNER'S LIMITS, never by
///         who is being paid. There is no recipient verification anywhere in this
///         contract; the Dojang seal is identity, not safety, and lives only in the
///         app as display.
///
///         Enforcement (deterministic):
///           - Native ETH within the per-transaction max AND within the remaining
///             rolling daily total: allowed on the passkey alone (one tap), to any
///             recipient.
///           - Over either limit: requires an email-delivered code (consumed here),
///             bound to the exact payment. The app also forces a hold-to-confirm.
///           - Any standard token movement/authorization (transfer, transferFrom,
///             approve, setApprovalForAll) can't be ETH-priced, so it always
///             requires the code — nothing is silently unbounded.
///
///         Limit changes: LOWERING is passkey-only (strengthening). RAISING or
///         disabling (setting to UNLIMITED) requires the code, so a device thief
///         can spend at most the headroom the owner chose and can never raise it.
///
///         The full guarantee also needs the account to keep the guard un-swappable
///         and itself un-upgradable by a passkey-only attacker — that is the V4/V5
///         account's sensitiveOpLock (email code on setGuard/upgradeTo/disable),
///         enabled at onboarding once a recovery email is confirmed. Without a
///         recovery email no code can be minted, so over-limit sends and limit
///         raises are simply impossible until one is set; the account stays bounded
///         by its default limits meanwhile.
///
///         Window: a fixed 24h window anchored on the first spend after a reset. A
///         prolonged attacker is bounded to `daily` per 24h — inherent to any daily
///         cap. Losses are bounded by the owner's own numbers.
contract OndolSpendingGuard is IOndolTransferGuard {
    using HexStrings for address;
    using HexStrings for bytes32;

    error InvalidLimits();

    event LimitsSet(address indexed account, uint128 perTx, uint128 daily);
    event Spent(address indexed account, address indexed recipient, uint256 value, bool overLimit);
    event TokenGated(address indexed account, address indexed token);

    struct Account {
        uint128 perTx; // 0 = use default
        uint128 daily; // 0 = use default
        uint128 spent; // spent in the current window
        uint64 windowStart; // anchor of the current 24h window (0 = none yet)
        uint64 opNonce; // ++ on every consumed code (send or limit change)
    }

    uint256 private constant WINDOW = 1 days;
    uint128 private constant UNLIMITED = type(uint128).max;

    // Standard token movement / authorization selectors — always code-gated.
    bytes4 private constant ERC20_TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 private constant ERC20_TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)
    bytes4 private constant ERC20_APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 private constant ERC721_SET_APPROVAL_FOR_ALL = 0xa22cb465; // setApprovalForAll(address,bool)

    SuhoCodeAttester public immutable codeAttester;
    uint128 public immutable defaultPerTx;
    uint128 public immutable defaultDaily;

    mapping(address => Account) private accts;

    constructor(SuhoCodeAttester _codeAttester, uint128 _defaultPerTx, uint128 _defaultDaily) {
        if (_defaultPerTx == 0 || _defaultDaily == 0) revert InvalidLimits();
        codeAttester = _codeAttester;
        defaultPerTx = _defaultPerTx;
        defaultDaily = _defaultDaily;
    }

    // ---- enforcement: called by the account's execute; msg.sender IS the account ----

    /// @notice Policy for one call. Reverts to block (a consumed-code failure
    ///         propagates and reverts the whole execute); a non-reverting return
    ///         allows the call. The verdict is informational.
    function check(Call calldata call, string calldata code) external returns (Verdict) {
        Account storage a = accts[msg.sender];

        // Token movement/authorization: can't be priced in ETH, so it always needs
        // the second factor. Bound the code to the exact (token, calldata).
        if (_isTokenDanger(call.data)) {
            codeAttester.verifyAndConsume(msg.sender, _tokenDomain(msg.sender, call.target, call.data, a.opNonce), code);
            a.opNonce = a.opNonce + 1;
            emit TokenGated(msg.sender, call.target);
            return Verdict.ALLOW;
        }

        uint256 value = call.value;
        if (value == 0) return Verdict.ALLOW; // no native value moves — limits don't apply

        (uint128 perTx, uint128 daily) = _effective(a);

        // Roll the 24h window (anchored on the first spend after a reset).
        uint64 windowStart = a.windowStart;
        uint128 spent = a.spent;
        if (windowStart == 0 || block.timestamp >= uint256(windowStart) + WINDOW) {
            windowStart = uint64(block.timestamp);
            spent = 0;
        }

        bool over = value > perTx || uint256(spent) + value > daily;
        if (over) {
            codeAttester.verifyAndConsume(msg.sender, _ethDomain(msg.sender, call.target, value, a.opNonce), code);
            a.opNonce = a.opNonce + 1;
        }

        // Record the spend. An authorized over-limit amount counts toward the daily
        // window too, so one code can't then unlock free in-limit draining.
        uint256 newSpent = uint256(spent) + value;
        a.windowStart = windowStart;
        a.spent = newSpent > UNLIMITED ? UNLIMITED : uint128(newSpent);
        emit Spent(msg.sender, call.target, value, over);
        return Verdict.ALLOW;
    }

    // ---- limits: set by the owner via the account's execute (msg.sender = account) ----

    /// @notice Set this account's limits. LOWERING (strengthening) is passkey-only.
    ///         RAISING either limit, or disabling (setting to UNLIMITED), consumes
    ///         an email code bound to (account, perTx, daily, nonce). Limits of 0
    ///         are invalid (0 means "unset → default"); pass UNLIMITED to disable.
    function setLimits(uint128 perTx, uint128 daily, string calldata code) external {
        if (perTx == 0 || daily == 0) revert InvalidLimits();
        Account storage a = accts[msg.sender];
        (uint128 curTx, uint128 curDaily) = _effective(a);
        if (perTx > curTx || daily > curDaily) {
            codeAttester.verifyAndConsume(msg.sender, _limitDomain(msg.sender, perTx, daily, a.opNonce), code);
            a.opNonce = a.opNonce + 1;
        }
        a.perTx = perTx;
        a.daily = daily;
        emit LimitsSet(msg.sender, perTx, daily);
    }

    // ---- views ----

    function limitsOf(address account) external view returns (uint128 perTx, uint128 daily) {
        return _effective(accts[account]);
    }

    function opNonce(address account) external view returns (uint64) {
        return accts[account].opNonce;
    }

    function spentToday(address account) external view returns (uint128) {
        Account storage a = accts[account];
        if (a.windowStart == 0 || block.timestamp >= uint256(a.windowStart) + WINDOW) return 0;
        return a.spent;
    }

    function remainingToday(address account) external view returns (uint128) {
        Account storage a = accts[account];
        (, uint128 daily) = _effective(a);
        uint128 s = (a.windowStart == 0 || block.timestamp >= uint256(a.windowStart) + WINDOW) ? 0 : a.spent;
        return s >= daily ? 0 : daily - s;
    }

    // ---- internals ----

    function _effective(Account storage a) private view returns (uint128 perTx, uint128 daily) {
        perTx = a.perTx == 0 ? defaultPerTx : a.perTx;
        daily = a.daily == 0 ? defaultDaily : a.daily;
    }

    function _isTokenDanger(bytes calldata data) private pure returns (bool) {
        if (data.length < 4) return false;
        bytes4 s = bytes4(data[:4]);
        return s == ERC20_TRANSFER || s == ERC20_TRANSFER_FROM || s == ERC20_APPROVE || s == ERC721_SET_APPROVAL_FOR_ALL;
    }

    function _ethDomain(address account, address recipient, uint256 value, uint64 nonce)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            "suho.spend:",
            account.toHexString(),
            ":",
            recipient.toHexString(),
            ":",
            bytes32(value).toHexString(),
            ":",
            bytes32(uint256(nonce)).toHexString()
        );
    }

    function _tokenDomain(address account, address token, bytes calldata data, uint64 nonce)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            "suho.token:",
            account.toHexString(),
            ":",
            token.toHexString(),
            ":",
            keccak256(data).toHexString(),
            ":",
            bytes32(uint256(nonce)).toHexString()
        );
    }

    function _limitDomain(address account, uint128 perTx, uint128 daily, uint64 nonce)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            "suho.limit:",
            account.toHexString(),
            ":",
            bytes32(uint256(perTx)).toHexString(),
            ":",
            bytes32(uint256(daily)).toHexString(),
            ":",
            bytes32(uint256(nonce)).toHexString()
        );
    }
}
