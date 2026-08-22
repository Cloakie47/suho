import { parseAbi, encodeFunctionData, type Hex } from "viem";
import { flashClient, readImpl, withRpcRetry, type Call } from "./chain";
import { CURRENT_TARGET, ONDOL_V3_IMPL } from "./config";

/// Account convergence — the permanent, universal replacement for "migration".
///
/// There are no upgrade generations a user must think about. There is ONE current
/// account (CURRENT_TARGET: an impl + a guard, derived from deployments). Any
/// account behind it converges to it silently, riding the owner's OWN next action:
/// convergenceCalls() returns the delta as plain calls, and the execute layer
/// prepends them into the SAME batch, so it is one passkey tap. No version words
/// ever reach the UI.
///
/// The account caches its guard at execute() entry (see OndolAccountV5._runCalls),
/// so a converging batch's OWN action is still judged by the OUTGOING guard;
/// convergence takes effect from the next action. Both convergence calls are
/// zero-value self-calls that every guard permits, so convergence itself never
/// reverts — it can only ride along, never block.

// V3 exposes one-arg upgradeTo(address); V4+ two-arg upgradeTo(address, string).
// The selector depends on the account's CURRENT impl, not the target.
const upgradeV3Abi = parseAbi(["function upgradeTo(address newImplementation)"]);
const upgradeV4Abi = parseAbi(["function upgradeTo(address newImplementation, string code)"]);
const setGuardAbi = parseAbi(["function setGuard(address guard_, string code)"]);
const guardViewAbi = parseAbi(["function guard() view returns (address)"]);
const lockViewAbi = parseAbi(["function sensitiveOpLock() view returns (bool)"]);

const selfCall = (account: Hex, data: Hex): Call[] => [{ target: account, value: 0n, data }];

/** The calls that bring `account` to CURRENT_TARGET, read from ground truth (live
 *  ERC-1967 slot + guard(), Flashblocks-fresh). Empty when already current, or when
 *  the account cannot converge silently:
 *   - pinned / non-proxy (no upgrade path) — it keeps working on what it has;
 *   - locked (sensitiveOpLock on) — setGuard/upgrade need an emailed code, so it
 *     converges through that code flow, not silently.
 *  Order matters: upgradeTo first, so the following setGuard self-call resolves the
 *  new impl's two-arg signature. */
export async function convergenceCalls(account: Hex): Promise<Call[]> {
  const impl = await readImpl(account); // ground truth from the proxy slot
  if (!impl) return []; // non-proxy pinned account: no converge path, keep working

  // A lock makes setGuard/upgrade code-gated — those converge through the code flow,
  // never silently. Reads the current impl's lock; a pre-V4 impl has no such view
  // (read reverts) and cannot be locked, so treat a failure as unlocked.
  const locked = await withRpcRetry(() =>
    flashClient.readContract({ address: account, abi: lockViewAbi, functionName: "sensitiveOpLock" }),
  ).catch(() => false);
  if (locked) return [];

  const calls: Call[] = [];

  if (impl.toLowerCase() !== CURRENT_TARGET.impl.toLowerCase()) {
    const data =
      impl.toLowerCase() === ONDOL_V3_IMPL.toLowerCase()
        ? encodeFunctionData({ abi: upgradeV3Abi, functionName: "upgradeTo", args: [CURRENT_TARGET.impl] })
        : encodeFunctionData({ abi: upgradeV4Abi, functionName: "upgradeTo", args: [CURRENT_TARGET.impl, ""] });
    calls.push(...selfCall(account, data));
  }

  const curGuard = await withRpcRetry(() =>
    flashClient.readContract({ address: account, abi: guardViewAbi, functionName: "guard" }),
  ).catch(() => null);
  if (curGuard && curGuard.toLowerCase() !== CURRENT_TARGET.guard.toLowerCase()) {
    const data = encodeFunctionData({ abi: setGuardAbi, functionName: "setGuard", args: [CURRENT_TARGET.guard, ""] });
    calls.push(...selfCall(account, data));
  }

  return calls;
}

/** True if `account` is behind CURRENT_TARGET and will converge on its next action.
 *  Lets a caller narrate "Preparing your account… first time only" without leaking
 *  any version vocabulary. */
export async function needsConvergence(account: Hex): Promise<boolean> {
  return (await convergenceCalls(account)).length > 0;
}
