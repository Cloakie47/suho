import type { Hex } from "viem";
import { api } from "./api";
import { accountNonce, computeChallenge, watchReceipt, type Call } from "./chain";
import { assertWithPasskey } from "./webauthn";
import { DEMO_ACCOUNT, LS_CREDENTIAL } from "./config";

/** Shared passkey-authorized execute: sign over (account, chain, nonce, calls),
 *  relay through the guardian, watch Flashblocks for the real timing. */
export async function executeWithPasskey(
  calls: Call[],
  otpCode = "",
): Promise<{ txHash: Hex; preconfMs: number }> {
  const credentialId = localStorage.getItem(LS_CREDENTIAL);
  if (!credentialId) throw new Error("No passkey linked on this device — visit Upgrade first.");
  const nonce = await accountNonce(DEMO_ACCOUNT);
  const challenge = computeChallenge(DEMO_ACCOUNT, nonce, calls);
  const webauthn = await assertWithPasskey(credentialId, challenge);
  const t0 = performance.now();
  const { txHash } = await api.relay(
    DEMO_ACCOUNT,
    calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })),
    otpCode,
    webauthn,
  );
  const timing = await watchReceipt(txHash, t0);
  return { txHash, preconfMs: timing.preconfMs };
}
