import { parseAbi, encodeFunctionData, type Hex } from "viem";
import { api } from "./api";
import { executeWithPasskey } from "./execute";
import { assertWithPasskey } from "./webauthn";
import { storedCredential, ONDOL_V4_IMPL } from "./config";
import type { Call } from "./chain";

/// Phase SEC 2.3 client: the OndolAccountV4 email second factor.
///
/// Every lock op is a passkey-signed self-call through execute(). The ones that
/// require the email code (disable, gated setGuard/upgrade, large send) carry the
/// code the user read from their inbox, so the action is a genuine 2-of-2: the
/// passkey prompt plus a code the passkey cannot produce.

const v4Abi = parseAbi([
  "function setGuard(address guard_, string code)",
  "function enableSensitiveOpLock()",
  "function disableSensitiveOpLock(string code)",
  "function enableEmailLargeSendLock()",
  "function disableEmailLargeSendLock(string code)",
]);

// Migrating TO V4 runs the CURRENT impl's upgradeTo, which for a V3 account is
// the one-arg `upgradeTo(address)` (no code). V4's own upgradeTo takes a second
// `code` arg, but that signature only exists once the account is already on V4,
// so it must never be used for the V3 -> V4 migration itself.
const migrateAbi = parseAbi(["function upgradeTo(address newImplementation)"]);

const selfCall = (account: Hex, data: Hex): Call[] => [{ target: account, value: 0n, data }];

// ---- passkey-gated code requests (the code itself is emailed, never returned) ----
async function opChallengeSig(account: Hex) {
  const cred = storedCredential();
  if (!cred) throw new Error("No passkey linked on this device.");
  const { challenge } = await api.opChallenge(account);
  return assertWithPasskey(cred, challenge);
}

/** Ask the guardian to email a sensitive-op code (setguard/upgrade/disablelock/
 *  disablesendlock). Resolves when the email is on its way; the code is not
 *  returned here. */
export async function requestOpCode(account: Hex, op: string, param?: Hex): Promise<void> {
  await api.opRequestCode(account, op, param, await opChallengeSig(account));
}

/** Ask the guardian to email a large-send code bound to (recipient, value). */
export async function requestSendCode(account: Hex, recipient: Hex, valueWei: string): Promise<void> {
  await api.opRequestSendCode(account, recipient, valueWei, await opChallengeSig(account));
}

// ---- the lock ops (each a passkey-signed execute on the active account) ----
export async function upgradeToV4(account: Hex): Promise<Hex> {
  // V3 -> V4 migration: the current (V3) impl's one-arg upgradeTo.
  const data = encodeFunctionData({ abi: migrateAbi, functionName: "upgradeTo", args: [ONDOL_V4_IMPL] });
  return (await executeWithPasskey(selfCall(account, data))).txHash;
}
export async function enableSensitiveOpLock(account: Hex): Promise<Hex> {
  const data = encodeFunctionData({ abi: v4Abi, functionName: "enableSensitiveOpLock", args: [] });
  return (await executeWithPasskey(selfCall(account, data))).txHash;
}
export async function disableSensitiveOpLock(account: Hex, code: string): Promise<Hex> {
  const data = encodeFunctionData({ abi: v4Abi, functionName: "disableSensitiveOpLock", args: [code] });
  return (await executeWithPasskey(selfCall(account, data))).txHash;
}
export async function enableEmailLargeSendLock(account: Hex): Promise<Hex> {
  const data = encodeFunctionData({ abi: v4Abi, functionName: "enableEmailLargeSendLock", args: [] });
  return (await executeWithPasskey(selfCall(account, data))).txHash;
}
export async function disableEmailLargeSendLock(account: Hex, code: string): Promise<Hex> {
  const data = encodeFunctionData({ abi: v4Abi, functionName: "disableEmailLargeSendLock", args: [code] });
  return (await executeWithPasskey(selfCall(account, data))).txHash;
}
/** A guard change gated by the control lock: pass the emailed code. */
export async function setGuardGated(account: Hex, newGuard: Hex, code: string): Promise<Hex> {
  const data = encodeFunctionData({ abi: v4Abi, functionName: "setGuard", args: [newGuard, code] });
  return (await executeWithPasskey(selfCall(account, data))).txHash;
}

/** Is this account running the V4 implementation (email-second-factor capable)? */
export function isV4(status: { implementation?: Hex | null }): boolean {
  return (status.implementation ?? "").toLowerCase() === ONDOL_V4_IMPL.toLowerCase();
}
