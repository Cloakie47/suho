import { encodeAbiParameters, keccak256, encodeAbiParameters as enc, type Hex } from "viem";

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

/** The execute() challenge: keccak256(abi.encode(account, chainId, nonce, calls)). */
export function computeChallenge(
  account: Hex,
  chainId: bigint,
  nonce: bigint,
  calls: { target: Hex; value: bigint; data: Hex }[],
): Hex {
  return keccak256(
    enc(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        {
          type: "tuple[]",
          components: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
        },
      ],
      [account, chainId, nonce, calls],
    ),
  );
}
