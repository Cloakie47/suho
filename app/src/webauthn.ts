import type { Hex } from "viem";

/// Browser-side WebAuthn. Raw artifacts (authenticatorData, clientDataJSON, DER
/// signature) are shipped to the guardian, which owns DER->(r,s) + low-s
/// normalization — the app never touches signature math.

export interface PasskeyInfo {
  credentialId: string; // base64url
  x: Hex;
  y: Hex;
}

export interface AssertionPayload {
  authenticatorDataB64: string;
  clientDataJSON: string;
  signatureB64: string;
}

const toB64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const hexToBytes = (hex: Hex): Uint8Array<ArrayBuffer> => {
  const h = hex.slice(2);
  const out = new Uint8Array(new ArrayBuffer(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** SPKI DER -> uncompressed point (x, y): last 65 bytes, 0x04-prefixed. */
function spkiToXY(spki: ArrayBuffer): { x: Hex; y: Hex } {
  const raw = new Uint8Array(spki);
  const point = raw.subarray(raw.length - 65);
  if (point[0] !== 0x04) throw new Error("unexpected SPKI point format");
  const hex = (b: Uint8Array) =>
    ("0x" + Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("")) as Hex;
  return { x: hex(point.subarray(1, 33)), y: hex(point.subarray(33, 65)) };
}

export async function createPasskey(label: string): Promise<PasskeyInfo> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Suho", id: "localhost" },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: label,
        displayName: label,
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256/P-256 only
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60_000,
    },
  })) as PublicKeyCredential;
  const resp = cred.response as AuthenticatorAttestationResponse;
  const { x, y } = spkiToXY(resp.getPublicKey()!);
  return { credentialId: cred.id, x, y };
}

/** DER ECDSA -> raw 64-byte r||s (IEEE P1363) for WebCrypto verification. */
function derToP1363(der: Uint8Array): Uint8Array<ArrayBuffer> {
  if (der[0] !== 0x30) throw new Error("not a DER signature");
  let idx = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const readInt = (): Uint8Array => {
    if (der[idx] !== 0x02) throw new Error("bad DER integer");
    const len = der[idx + 1];
    let start = idx + 2;
    let end = start + len;
    idx = end;
    while (der[start] === 0 && end - start > 32) start++; // strip pad
    return der.subarray(start, end);
  };
  const r = readInt();
  const s = readInt();
  const out = new Uint8Array(new ArrayBuffer(64));
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

/**
 * Relink flow: the ONE deliberately unpinned get() in the app. Used only when
 * an account has no stored credential mapping on this device (the shared-slot
 * era left accounts unmapped). The user picks a passkey from the platform
 * chooser; we then VERIFY the assertion against the account's on-chain P-256
 * key with WebCrypto before storing the mapping. A wrong pick never gets
 * saved and never reaches a transaction.
 */
export async function relinkPasskey(expected: { x: Hex; y: Hex }): Promise<string> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: "localhost",
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential;
  const resp = assertion.response as AuthenticatorAssertionResponse;

  // signed data per WebAuthn: authenticatorData || SHA-256(clientDataJSON)
  const clientHash = await crypto.subtle.digest("SHA-256", resp.clientDataJSON);
  const authData = new Uint8Array(resp.authenticatorData);
  const data = new Uint8Array(new ArrayBuffer(authData.length + 32));
  data.set(authData, 0);
  data.set(new Uint8Array(clientHash), authData.length);

  // uncompressed point 0x04 || x || y
  const point = new Uint8Array(new ArrayBuffer(65));
  point[0] = 0x04;
  point.set(hexToBytes(expected.x), 1);
  point.set(hexToBytes(expected.y), 33);
  const key = await crypto.subtle.importKey(
    "raw",
    point,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    derToP1363(new Uint8Array(resp.signature)),
    data,
  );
  if (!ok) throw new Error("That passkey doesn't control this account. Pick the one created for it.");
  return assertion.id;
}

/** Sign the 32-byte account challenge with a specific stored credential. */
export async function assertWithPasskey(
  credentialId: string,
  challenge: Hex,
): Promise<AssertionPayload> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(challenge),
      rpId: "localhost",
      allowCredentials: [{ type: "public-key", id: fromB64url(credentialId) }],
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential;
  const resp = assertion.response as AuthenticatorAssertionResponse;
  return {
    authenticatorDataB64: toB64url(resp.authenticatorData),
    clientDataJSON: new TextDecoder().decode(resp.clientDataJSON),
    signatureB64: toB64url(resp.signature),
  };
}
