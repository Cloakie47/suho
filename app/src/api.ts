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
  initialized: boolean;
  accountNonce: string;
  demoReady?: boolean;
  demoRequiredWei?: string;
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
  relay: (account: Hex, calls: { target: Hex; value: string; data: Hex }[], otpCode: string, webauthn: AssertionPayload) =>
    req<{ txHash: Hex; explorer: string }>("/relay", post({ account, calls, otpCode, webauthn })),
  otpRequest: (account: Hex, recipient: Hex, value: string) =>
    req<{ ok: boolean; expiresAt: number; attestationTx: string }>(
      "/otp/request",
      post({ account, recipient, value }),
    ),
  ariseRequest: (account: Hex, newPubKeyHash: Hex) =>
    req<{ ok: boolean; expiresAt: number; attestationTx: string }>(
      "/arise/request",
      post({ account, newPubKeyHash }),
    ),
  ariseComplete: (account: Hex, newX: Hex, newY: Hex, code: string) =>
    req<{ status: string; txHash: Hex; explorer: string }>(
      "/arise/complete",
      post({ account, newX, newY, code }),
    ),
  demoCredential: () => req<{ credentialId: string }>("/demo-credential"),
  /** O3: only an address, two signatures, and a public key ever travel. */
  onboard: (body: {
    address: Hex;
    authorization: { address: Hex; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number };
    initSig: { v: number; r: Hex; s: Hex };
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
};

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
