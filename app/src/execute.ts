import type { Hex } from "viem";
import { api } from "./api";
import { accountNonce, computeChallenge, isUpgradeable, watchReceipt, type Call } from "./chain";
import { assertWithPasskey } from "./webauthn";
import { activeAccount, storedCredential } from "./config";

/** For a proxy-fronted (V3) account, fetch the guardian's recommended cap so it
 *  can be signed into the challenge; undefined for legacy V2 (uncapped 3-arg). */
export async function capForAccount(account: Hex): Promise<bigint | undefined> {
  if (!(await isUpgradeable(account))) return undefined;
  return BigInt((await api.fee()).maxGasPayment);
}

/** Lifecycle hooks so the caller's toast can mutate as the tx progresses.
 *  `sent` fires once the relay accepted the tx (toast goes pending). */
export interface ExecuteHooks {
  sent?(txHash: Hex): void;
  preconf?(ms: number): void;
  final?(txHash: Hex, inclusionMs: number): void;
  reverted?(txHash: Hex): void;
}

/** Shared passkey-authorized execute: sign over (account, chain, nonce, calls),
 *  relay through the guardian, watch Flashblocks for the real timing. */
export async function executeWithPasskey(
  calls: Call[],
  otpCode = "",
  hooks?: ExecuteHooks,
): Promise<{ txHash: Hex; preconfMs: number }> {
  const account = activeAccount();
  const credentialId = storedCredential();
  if (!credentialId) throw new Error("No passkey linked on this device. Visit Upgrade first.");
  const [nonce, maxGasPayment] = await Promise.all([accountNonce(account), capForAccount(account)]);
  const challenge = computeChallenge(account, nonce, calls, maxGasPayment);
  const webauthn = await assertWithPasskey(credentialId, challenge);
  const t0 = performance.now();
  const { txHash } = await api.relay(
    account,
    calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })),
    otpCode,
    webauthn,
    maxGasPayment?.toString(),
  );
  hooks?.sent?.(txHash);
  const timing = await watchReceipt(txHash, t0, {
    preconf: (ms) => hooks?.preconf?.(ms),
    final: (ms) => hooks?.final?.(txHash, ms),
    reverted: () => hooks?.reverted?.(txHash),
  });
  return { txHash, preconfMs: timing.preconfMs };
}
