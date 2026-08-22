import { GUARDIAN } from "./config";
import type { AssertionPayload } from "./webauthn";
import type { Hex } from "viem";

export interface Status {
  address: Hex;
  isVerified: boolean;
  verifiedBy: string | null;
  upId: string | null;
  balance: string;
  isOndolAccount: boolean;
  delegatedTo: Hex | null;
  /** "proxy" = upgradeable (Phase G onward); "v2"/"v1" = legacy, pinned. */
  delegationShape?: "proxy" | "v2" | "v1" | "unknown" | "none";
  /** Active implementation behind the proxy, or the designator for a legacy account. */
  implementation?: Hex | null;
  /** True only for proxy-fronted accounts; legacy accounts cannot upgrade. */
  upgradeable?: boolean;
  initialized: boolean;
  accountNonce: string;
  /** V4 email second-factor state (all false/"0" on pre-V4 accounts). */
  locks?: { sensitiveOpLock: boolean; emailLargeSendLock: boolean; sensitiveOpNonce: string };
  /** Global: sponsored onboarding is paused (relayer below its floor). */
  sponsoredOnboardingPaused?: boolean;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${GUARDIAN}${path}`, init);
  } catch (e) {
    // Network-level failure (guardian down, CORS, offline). Preserve the raw
    // text for the details disclosure; humanError maps "Failed to fetch".
    throw new GuardianError("Failed to fetch", String(e));
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new GuardianError(body.error ?? `HTTP ${r.status}`);
  return body as T;
}

export class GuardianError extends Error {
  raw?: string;
  constructor(message: string, raw?: string) {
    super(message);
    this.raw = raw;
  }
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  status: (address: string) => req<Status>(`/status?address=${address}`),
  resolve: (name: string) =>
    req<{ address: Hex | null; verified: boolean; verifiedBy: string | null }>(
      `/resolve?name=${encodeURIComponent(name)}`,
    ),
  upgrade: (address: string, passkey: { x: Hex; y: Hex }) =>
    req<{ status: string; txHash: Hex; explorer: string; code: string; initialized: boolean }>(
      "/upgrade",
      post({ address, passkey }),
    ),
  /** maxGasPayment (wei string) is signed into the V3 challenge for proxy
   *  accounts; omit it for legacy V2 accounts (3-arg execute). */
  relay: (
    account: Hex,
    calls: { target: Hex; value: string; data: Hex }[],
    otpCode: string,
    webauthn: AssertionPayload,
    maxGasPayment?: string,
  ) =>
    req<{ txHash: Hex; explorer: string }>(
      "/relay",
      post({ account, calls, otpCode, webauthn, maxGasPayment }),
    ),
  fee: () =>
    req<{ maxGasPayment: string; gasPrice: string; l1UpperBound: string; eth: string }>("/fee"),
  // Horizon 1 S1: encode a WebAuthn assertion over `hash` into the ERC-1271
  // signature bytes (guardian owns the DER->low-s->ABI math). Used by /connect.
  sign1271: (account: Hex, hash: Hex, assertion: AssertionPayload) =>
    req<{ signature: Hex }>("/sign1271", post({ account, hash, assertion })),
  // Bank model: email a code to authorize an over-limit send / a limit raise.
  // Delivered only to the recovery email, throttled per account. Not passkey-gated:
  // the send/setLimits that consumes the code carries the only signature that
  // matters, so a second assertion to request the email would be theater.
  requestSpendCode: (account: Hex, recipient: Hex, value: string) =>
    req<{ ok: boolean }>("/spend/request-code", post({ account, recipient, value })),
  requestLimitCode: (account: Hex, perTx: string, daily: string) =>
    req<{ ok: boolean }>("/limit/request-code", post({ account, perTx, daily })),
  // (Transfer-OTP retrieval removed: a large unverified send is gated by the
  //  passkey + hold-to-confirm, not a code. See Send.tsx / OndolTransferGuard.)
  // ---- H2: recovery binding ----
  recoveryStatus: (account: Hex) =>
    req<{ enabled: boolean }>(`/recovery?account=${account}`),
  recoveryChallenge: (account: Hex) =>
    req<{ challenge: Hex }>(`/recovery/challenge?account=${account}`),
  recoveryRequestCode: (account: Hex, email: string, webauthn: AssertionPayload) =>
    req<{ ok: boolean }>("/recovery/request-code", post({ account, email, webauthn })),
  recoveryConfirm: (account: Hex, email: string, code: string) =>
    req<{ ok: boolean }>("/recovery/confirm", post({ account, email, code })),
  // ---- H3: enumeration-resistant arise (code arrives by email) ----
  ariseRequest: (account: Hex, newPubKeyHash: Hex) =>
    req<{ message: string }>("/arise/request", post({ account, newPubKeyHash })),
  ariseComplete: (account: Hex, newX: Hex, newY: Hex, code: string) =>
    req<{ status: string; txHash: Hex; explorer: string }>(
      "/arise/complete",
      post({ account, newX, newY, code }),
    ),
  /** O3: only an address, two signatures, and a public key ever travel. */
  onboard: (body: {
    address: Hex;
    authorization: { address: Hex; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number };
    initSig: { v: number; r: Hex; s: Hex };
    /** ProxyInit signature over the V3 implementation the proxy may install. */
    proxySig: { v: number; r: Hex; s: Hex };
    passkey: { x: Hex; y: Hex };
  }) =>
    req<{ status: string; txHash: Hex; explorer: string; initialized: boolean }>(
      "/onboard",
      post(body),
    ),
  verifyMe: (account: Hex) =>
    req<{ calls: { target: Hex; value: string; data: Hex }[]; feeWei: string }>(
      "/verify-me",
      post({ account }),
    ),
  claimName: (account: Hex, label: string) =>
    req<{ calls: { target: Hex; value: string; data: Hex }[]; label: string }>(
      "/claim-name",
      post({ account, label }),
    ),
  card: (id: string) => req<CardInfo>(`/card?id=${encodeURIComponent(id)}`),
  directory: (q = "", refresh = false) =>
    req<{ entries: DirEntry[]; total: number; shown: number; scannedToBlock: string }>(
      `/directory?q=${encodeURIComponent(q)}${refresh ? "&refresh=1" : ""}`,
    ),
  // ---- Phase M: return requests (memos are on-chain, read from events) ----
  // Creating a request carries a content-bound passkey assertion (`sig`). Reads
  // (inbox/sent) are PUBLIC — viewable by address, our public-for-now stance.
  // Receiver actions present a short-lived bearer session (memory only).
  msgReturnRequest: (account: Hex, txHash: Hex, body: string, sig: AssertionPayload) =>
    req<{ ok: boolean; message?: TxMessageWire }>(
      "/messages/return-request",
      post({ account, txHash, body, sig }),
    ),
  // ---- Phase SEC 2.3: V4 email second-factor op codes ----
  opChallenge: (account: Hex) => req<{ challenge: Hex }>(`/op/challenge?account=${account}`),
  opRequestCode: (account: Hex, op: string, param: Hex | undefined, webauthn: AssertionPayload) =>
    req<{ ok: boolean }>("/op/request-code", post({ account, op, param, webauthn })),
  opRequestSendCode: (account: Hex, recipient: Hex, value: string, webauthn: AssertionPayload) =>
    req<{ ok: boolean }>("/op/request-send-code", post({ account, recipient, value, webauthn })),
  msgChallenge: (account: Hex) => req<{ challenge: Hex }>(`/messages/challenge?account=${account}`),
  msgSession: (account: Hex, sig: AssertionPayload) =>
    req<{ token: string; expiresAt: number }>("/messages/session", post({ account, sig })),
  msgInbox: (account: Hex) => req<{ items: TxMessageWire[] }>(`/messages/inbox?account=${account}`),
  msgSent: (account: Hex) => req<{ items: TxMessageWire[] }>(`/messages/sent?account=${account}`),
  msgRespond: (messageId: number, action: "decline" | "dismiss" | "block", token: string) =>
    req<{ ok: boolean }>("/messages/respond", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ messageId, action }),
    }),
  // Public: the guardian verifies the return tx on-chain before marking.
  msgMarkReturned: (messageId: number, returnTxHash: Hex) =>
    req<{ ok: boolean }>("/messages/mark-returned", post({ messageId, returnTxHash })),
};

export interface TxMessageWire {
  id: number;
  kind: "return_request" | "reminder";
  txHash: Hex;
  from: Hex;
  to: Hex;
  /** "ETH" or a lowercased token address. */
  token: string;
  amountWei: string;
  body: string;
  status: "active" | "declined" | "dismissed" | "returned";
  returnTxHash: Hex | null;
  createdAt: string;
}

// Cached account status for the switcher: statuses change rarely, so a short TTL
// cache turns "Accounts on this device" from N serial RPC round-trips into an
// instant render (from cache/local) with fresh values filling in.
const statusCache = new Map<string, { at: number; status: Status }>();
export async function cachedStatus(address: string, ttlMs = 60_000): Promise<Status> {
  const key = address.toLowerCase();
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.status;
  const s = await api.status(address);
  statusCache.set(key, { at: Date.now(), status: s });
  return s;
}
/** Synchronous peek at a cached status (no fetch) — for an instant first paint. */
export function peekStatus(address: string): Status | undefined {
  return statusCache.get(address.toLowerCase())?.status;
}

export interface DirEntry {
  name: string;
  address: Hex;
  active: boolean;
}

export interface CardVersion {
  uid: Hex;
  displayName: string;
  contact: string;
  remarks: string;
  time: number;
  revocationTime: number;
  refUID: Hex;
  version: number;
}

export interface CardInfo {
  address: Hex | null;
  current: CardVersion | null;
  history: CardVersion[];
}
