import {
  keccak256,
  encodeAbiParameters,
  toBytes,
  getAddress,
  encodeFunctionData,
  parseAbi,
  type Hex,
} from "viem";
import { api, type TxMessageWire } from "./api";
import { assertWithPasskey } from "./webauthn";
import { storedCredential, SUHO_MEMO } from "./config";
import type { Call } from "./chain";

/// Phase M client.
///
/// MEMOS are on-chain and PUBLIC: a note is appended as a second call in the same
/// execute() batch as the transfer (see memoCall), so one passkey tap produces one
/// atomic tx carrying transfer + memo. Memos are read back from SuhoMemo `Memo`
/// events (see activity.ts), never from the guardian.
///
/// RETURN REQUESTS are guardian-stored. Reads are PUBLIC (viewable by address, our
/// public-for-now stance) — no unlock. Only receiver ACTIONS (decline/dismiss/
/// block, mark-returned) require auth: they lazily obtain a short-lived passkey
/// session (memory only) the first time one is taken.

export const MEMO_MAX = 140;
export const REQUEST_MAX = 280;

const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]", "g");
/** Strip HTML angle brackets and control chars, then trim. Applied before the
 *  memo goes on-chain and before a request body is signed. */
export function sanitizeBody(raw: string): string {
  return raw.replace(/[<>]/g, "").replace(CONTROL_CHARS, "").trim();
}

// ---- on-chain memo (batched into the transfer's execute) ----
const suhoMemoAbi = parseAbi(["function note(address to, string text)"]);

/** Build the SuhoMemo.note call to append to a send's execute batch. Returns null
 *  if the sanitized text is empty. The 140-char cap is enforced here and again in
 *  the contract. */
export function memoCall(recipient: Hex, text: string): Call | null {
  const clean = sanitizeBody(text).slice(0, MEMO_MAX);
  if (!clean) return null;
  return {
    target: SUHO_MEMO,
    value: 0n,
    data: encodeFunctionData({ abi: suhoMemoAbi, functionName: "note", args: [recipient, clean] }),
  };
}

function credential(): string {
  const id = storedCredential();
  if (!id) throw new Error("No passkey linked on this device.");
  return id;
}

// ---- return request (content-bound passkey, one prompt) ----
const requestChallenge = (account: Hex, txHash: Hex, body: string): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
      ["suho.txmsg.return.v1", getAddress(account), txHash, keccak256(toBytes(body))],
    ),
  );

export async function requestReturn(account: Hex, txHash: Hex, body: string): Promise<void> {
  const clean = sanitizeBody(body);
  const sig = await assertWithPasskey(credential(), requestChallenge(account, txHash, clean));
  await api.msgReturnRequest(account, txHash, clean, sig);
}

// ---- receiver action session (memory only, lazily obtained) ----
let session: { account: string; token: string; expiresAt: number } | null = null;

function liveSession(account: Hex): boolean {
  return (
    session !== null &&
    session.account === account.toLowerCase() &&
    session.expiresAt > Date.now() + 5_000
  );
}

/** Get (or mint) the action session for `account`. Prompts the passkey only when
 *  no live session exists. The token never leaves memory. Called under the hood
 *  by the receiver actions — there is no separate "unlock" step for viewing. */
async function actionToken(account: Hex): Promise<string> {
  if (liveSession(account)) return session!.token;
  const { challenge } = await api.msgChallenge(account);
  const sig = await assertWithPasskey(credential(), challenge);
  const { token, expiresAt } = await api.msgSession(account, sig);
  session = { account: account.toLowerCase(), token, expiresAt };
  return token;
}

/** Drop the in-memory action session (e.g. on account switch). */
export function lockMessages(): void {
  session = null;
}

// Receiver control actions reuse the lazily-obtained session (a passkey proof of
// account control): Return funds still needs a real send passkey; mark-returned
// is additionally gated by on-chain verification of the return tx; decline/
// dismiss/block are low-stakes.
export async function respondToMessage(
  receiver: Hex,
  messageId: number,
  action: "decline" | "dismiss" | "block",
): Promise<void> {
  const token = await actionToken(receiver);
  await api.msgRespond(messageId, action, token);
}
// mark-returned is public: the guardian verifies the return tx on-chain, so the
// send's own passkey is the only approval and Return stays one tap.
export async function markReturned(messageId: number, returnTxHash: Hex): Promise<void> {
  await api.msgMarkReturned(messageId, returnTxHash);
}

// ---- public reads (no auth) ----
export interface Threads {
  inbox: TxMessageWire[];
  sent: TxMessageWire[];
}

/** Return requests to/from the account. Public reads (no passkey). */
export async function loadThreads(account: Hex): Promise<Threads> {
  const [inbox, sent] = await Promise.all([api.msgInbox(account), api.msgSent(account)]);
  return { inbox: inbox.items, sent: sent.items };
}

/** Requests the account has SENT, indexed by anchored tx, for the status chip. */
export function sentRequestsByTx(threads: Threads): Map<string, TxMessageWire> {
  const m = new Map<string, TxMessageWire>();
  for (const msg of threads.sent) m.set(msg.txHash.toLowerCase(), msg);
  return m;
}

/** Active return requests RECEIVED (the inbox surface / indicator). */
export function activeInboxRequests(threads: Threads): TxMessageWire[] {
  return threads.inbox.filter((m) => m.status === "active");
}
