import { encodeAbiParameters, type Hex } from "viem";

/// WebAuthn plumbing between the browser and OndolAccount's verifier.
///
/// Binding rule (app spec note 2): browsers return ECDSA signatures DER-encoded;
/// the contract wants raw (r, s) with LOW-S normalization (the verifier rejects
/// high-s per the daimo malleability rule). Parse DER -> (r, s) -> normalize here,
/// in one place, before anything touches the chain.

export const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Parse a DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) to raw scalars. */
export function derToRS(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new Error("not a DER sequence");
  let idx = 2;
  if (der[1] & 0x80) idx = 2 + (der[1] & 0x7f); // long-form length (not seen for P-256, handled anyway)

  const readInt = (): bigint => {
    if (der[idx] !== 0x02) throw new Error("expected DER integer");
    const len = der[idx + 1];
    const start = idx + 2;
    idx = start + len;
    let v = 0n;
    for (let i = start; i < idx; i++) v = (v << 8n) | BigInt(der[i]);
    return v; // leading 0x00 padding bytes fold away naturally
  };

  const r = readInt();
  const s = readInt();
  if (r <= 0n || r >= P256_N || s <= 0n || s >= P256_N) throw new Error("signature scalar out of range");
  return { r, s };
}

/** Low-s normalization: the onchain verifier only accepts s <= n/2. */
export function normalizeS(s: bigint): bigint {
  return s > P256_N / 2n ? P256_N - s : s;
}

/** Extract (x, y) from a DER SPKI EC public key (as returned by getPublicKey()). */
export function spkiToXY(spkiB64: string): { x: Hex; y: Hex } {
  const raw = Buffer.from(spkiB64, "base64");
  const point = raw.subarray(raw.length - 65);
  if (point[0] !== 0x04) throw new Error("expected uncompressed EC point at end of SPKI");
  const x = `0x${Buffer.from(point.subarray(1, 33)).toString("hex")}` as Hex;
  const y = `0x${Buffer.from(point.subarray(33, 65)).toString("hex")}` as Hex;
  return { x, y };
}

export interface BrowserAssertion {
  authenticatorDataB64: string; // base64 (standard or url) of authenticatorData
  clientDataJSON: string; // utf8 string
  signatureB64: string; // base64 DER signature
}

const fromB64 = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/// Phase H (H4): verify a WebAuthn assertion OFF chain, against an account's
/// on-chain P-256 passkey. Used to gate transfer-OTP retrieval and email changes
/// on possession of the passkey — the user proves control before the guardian
/// reveals a code. Checks (1) the assertion signs exactly `challengeHex`, and
/// (2) the signature verifies under the account's public key (x, y). Standard
/// ECDSA verification (either s parity accepted; low-s is only a chain rule).
export async function verifyAssertion(
  pub: { x: Hex; y: Hex },
  challengeHex: Hex,
  assertion: BrowserAssertion,
): Promise<boolean> {
  const { webcrypto } = await import("node:crypto");
  // (1) the signed challenge, as base64url of the raw 32 bytes, must match.
  const expected = Buffer.from(challengeHex.slice(2), "hex").toString("base64url");
  let cd: { type?: string; challenge?: string };
  try {
    cd = JSON.parse(assertion.clientDataJSON);
  } catch {
    return false;
  }
  if (cd.type !== "webauthn.get" || cd.challenge !== expected) return false;

  // (2) verify sig over authenticatorData || SHA-256(clientDataJSON).
  const authData = fromB64(assertion.authenticatorDataB64);
  const clientHash = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", Buffer.from(assertion.clientDataJSON, "utf8")),
  );
  const signed = Buffer.concat([authData, clientHash]);
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pub.x.slice(2), "hex"),
    Buffer.from(pub.y.slice(2), "hex"),
  ]);
  const key = await webcrypto.subtle.importKey(
    "raw",
    point,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const { r, s } = derToRS(fromB64(assertion.signatureB64));
  const to32 = (v: bigint) => {
    const b = Buffer.alloc(32);
    let x = v;
    for (let i = 31; i >= 0; i--) {
      b[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return b;
  };
  const raw = Buffer.concat([to32(r), to32(s)]);
  return webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, signed);
}

/**
 * Convert a raw browser assertion into the ABI-encoded WebAuthnAuth blob that
 * OndolAccount.execute()/WebAuthnP256.verify() expects.
 */
export function encodeWebAuthnSig(assertion: BrowserAssertion): Hex {
  const clientData = assertion.clientDataJSON;
  const typeIndex = clientData.indexOf('"type":"webauthn.get"');
  const challengeIndex = clientData.indexOf('"challenge":"');
  if (typeIndex < 0 || challengeIndex < 0) throw new Error("malformed clientDataJSON");

  const { r, s } = derToRS(fromB64(assertion.signatureB64));
  const sLow = normalizeS(s);

  const authData = fromB64(assertion.authenticatorDataB64);
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "authenticatorData", type: "bytes" },
          { name: "clientDataJSON", type: "string" },
          { name: "challengeIndex", type: "uint256" },
          { name: "typeIndex", type: "uint256" },
          { name: "r", type: "uint256" },
          { name: "s", type: "uint256" },
        ],
      },
    ],
    [
      {
        authenticatorData: `0x${authData.toString("hex")}` as Hex,
        clientDataJSON: clientData,
        challengeIndex: BigInt(challengeIndex),
        typeIndex: BigInt(typeIndex),
        r,
        s: sLow,
      },
    ],
  );
}
