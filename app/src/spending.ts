import { parseAbi, encodeFunctionData, type Hex } from "viem";
import { api } from "./api";
import { executeWithPasskey } from "./execute";
import { SPENDING_GUARD_ADDRESS } from "./config";

/// Bank model client. Limits live in OndolSpendingGuard, per account. Lowering a
/// limit is passkey-only; raising it, disabling it, or sending over it needs a code
/// the guardian emails to the recovery address. This module is the one place the
/// app asks for those codes and applies limit changes.
///
/// Requesting a code is deliberately NOT passkey-gated. The only honest factors for
/// an over-limit action are the passkey that SIGNS it (bound to recipient+value, or
/// to the new limits) and the emailed code a device thief can't read. A second
/// passkey assertion just to request the email is the same key proving the same
/// thing twice — theater. The guardian throttles requests per account instead, so
/// the flow costs exactly one passkey prompt.

const guardAbi = parseAbi(["function setLimits(uint128 perTx, uint128 daily, string code)"]);

/// The disable sentinel: a uint128 max limit means "no cap". Setting either field
/// to this is a raise, so it needs the code.
export const UNLIMITED = 2n ** 128n - 1n;

/** Email a code to authorize an over-limit send, bound to (recipient, value). No
 *  passkey here: the send that follows carries the only signature that matters. */
export async function requestSpendCode(account: Hex, recipient: Hex, valueWei: string): Promise<void> {
  await api.requestSpendCode(account, recipient, valueWei);
}

/** Email a code to authorize a limit change up (or a disable), bound to the new
 *  pair. No passkey here: the setLimits that follows carries the signature. */
export async function requestLimitCode(account: Hex, perTx: bigint, daily: bigint): Promise<void> {
  await api.requestLimitCode(account, perTx.toString(), daily.toString());
}

/** Set new limits. Lowering (strengthening) passes an empty code; raising or
 *  disabling must pass the emailed code, which the guard consumes. */
export async function setLimits(account: Hex, perTx: bigint, daily: bigint, code: string): Promise<Hex> {
  const data = encodeFunctionData({ abi: guardAbi, functionName: "setLimits", args: [perTx, daily, code] });
  return (await executeWithPasskey([{ target: SPENDING_GUARD_ADDRESS, value: 0n, data }])).txHash;
}

/** A raise if either new limit exceeds the current one (a raise needs the code). */
export function isRaise(newPerTx: bigint, newDaily: bigint, curPerTx: bigint, curDaily: bigint): boolean {
  return newPerTx > curPerTx || newDaily > curDaily;
}

/** True if a send needs the emailed code: over the per-tx cap OR over the remaining daily. */
export function isOverLimit(valueWei: bigint, perTx: bigint, remaining: bigint): boolean {
  return valueWei > perTx || valueWei > remaining;
}
