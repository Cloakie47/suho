import type { Hex } from "viem";
import { api } from "./api";
import { accountNonce, computeChallenge, flashClient, isUpgradeable, watchReceipt, type Call } from "./chain";
import { assertWithPasskey, type AssertionPayload } from "./webauthn";
import { requireActiveAccount, storedCredential } from "./config";
import { fmtEth } from "./ui";

/** Thrown by assertAffordable when the account can't cover value + gas cap. It
 *  carries a ready-made human sentence (`.human`) that errors.ts surfaces
 *  verbatim, so the user is told the shortfall and where to fund BEFORE we ever
 *  prompt for a passkey or hit the chain. */
export class InsufficientFundsError extends Error {
  human: string;
  constructor(
    public account: Hex,
    public neededWei: bigint,
    public balanceWei: bigint,
  ) {
    super("InsufficientFunds");
    this.name = "InsufficientFundsError";
    this.human =
      `Not enough ETH. You need about ${fmtEth(neededWei)} ETH to cover this ` +
      `(this account has ${fmtEth(balanceWei)}). Add funds to ${account} and try again.`;
  }
}

/** Preflight: can `account` cover the sum of call values plus the gas
 *  reimbursement cap? Reads a fresh balance and throws InsufficientFundsError
 *  with a human message if not. Call this before signing/relaying any execute. */
export async function assertAffordable(
  account: Hex,
  calls: Call[],
  maxGasPayment?: bigint,
): Promise<void> {
  const balance = await flashClient.getBalance({ address: account });
  const needed = calls.reduce((sum, c) => sum + c.value, 0n) + (maxGasPayment ?? 0n);
  if (balance < needed) throw new InsufficientFundsError(account, needed, balance);
}

/** Sign a guardian-issued gate challenge with this device's passkey. Proves
 *  account control before the guardian reveals a code (H4) or binds recovery
 *  (H2). Throws if no passkey is linked here. */
export async function signGateChallenge(challenge: Hex): Promise<AssertionPayload> {
  const credentialId = storedCredential();
  if (!credentialId) throw new Error("No passkey linked on this device. Link it first.");
  return assertWithPasskey(credentialId, challenge);
}

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
  const account = requireActiveAccount();
  const credentialId = storedCredential();
  if (!credentialId) throw new Error("No passkey linked on this device. Visit Upgrade first.");
  const [nonce, maxGasPayment] = await Promise.all([accountNonce(account), capForAccount(account)]);
  // Affordability preflight BEFORE the passkey prompt: don't make the user
  // authenticate a transaction their account can't pay for.
  await assertAffordable(account, calls, maxGasPayment);
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
