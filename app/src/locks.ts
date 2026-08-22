import { parseAbi, encodeFunctionData, type Hex } from "viem";
import { api } from "./api";
import { executeWithPasskey } from "./execute";
import { assertWithPasskey } from "./webauthn";
import { storedCredential, ONDOL_V3_IMPL, ONDOL_V5_IMPL } from "./config";
import { readImpl, type Call } from "./chain";

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

// The upgrade selector depends on the account's CURRENT impl, not the target:
//   - V3 exposes one-arg  upgradeTo(address)                 (selector 0x3659cfe6)
//   - V4/V5 expose two-arg upgradeTo(address, string code)   (selector 0x36ba9794)
// Using the wrong one is a self-call to a selector the account doesn't have, which
// reverts CallFailed (the "couldn't complete" bug). Pick by current version.
const upgradeV3Abi = parseAbi(["function upgradeTo(address newImplementation)"]);
const upgradeV4Abi = parseAbi(["function upgradeTo(address newImplementation, string code)"]);

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

/** A pinned account (non-proxy delegation, bootstrap key destroyed) genuinely
 *  can't gain app sign-in or the locks. Carries `.human` so errors.ts surfaces the
 *  plain sentence rather than a generic "something went wrong". */
export class NotUpgradeableError extends Error {
  human = "This account can't use app sign-in or the email second factor. New accounts have both.";
  constructor() {
    super("NotUpgradeable");
    this.name = "NotUpgradeableError";
  }
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

type ImplStatus = {
  implementation?: Hex | null;
  delegationShape?: "proxy" | "v2" | "v1" | "unknown" | "none";
};

/** THE SINGLE SOURCE OF TRUTH for what an account can do. Every legacy/upgrade/
 *  sign-in decision in the app derives from this — no local re-derivations, no
 *  inferring capability from an optional field's falsiness or an impl allow-list.
 *
 *  Capability comes from the DELEGATION SHAPE (the guardian's structural signal):
 *    - isProxy  → an upgradeable account (can hold locks, can gain app sign-in)
 *    - isPinned → EXACTLY a v1/v2 non-proxy account (bootstrap key destroyed; it
 *                 can never be upgraded). Nothing else is ever "pinned/legacy".
 *  Version (isV5, informational) reads the impl; when the /status impl is stale it
 *  may be wrong, so it is NEVER used to decide pinned/upgradeable — only the shape
 *  is, and the actual upgrade re-reads ground truth in ensureV5. */
export interface AccountCaps {
  isProxy: boolean;
  isPinned: boolean;
  isV5: boolean;
  canManageLocks: boolean; // any proxy account (bridges to V5 on first enable)
  needsBridge: boolean; // proxy but not yet V5 → a silent one-time upgrade
}
export function accountCaps(status: ImplStatus): AccountCaps {
  const shape = status.delegationShape;
  const isProxy = shape === "proxy";
  const isPinned = shape === "v1" || shape === "v2";
  const isV5 = (status.implementation ?? "").toLowerCase() === ONDOL_V5_IMPL.toLowerCase();
  return { isProxy, isPinned, isV5, canManageLocks: isProxy, needsBridge: isProxy && !isV5 };
}

// Thin, named wrappers over the one source (kept so call sites read clearly).
export const isPinnedAccount = (s: ImplStatus): boolean => accountCaps(s).isPinned;
export const canManageLocks = (s: ImplStatus): boolean => accountCaps(s).canManageLocks;
