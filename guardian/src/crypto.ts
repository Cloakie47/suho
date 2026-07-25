import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/// Phase H email-at-rest. Recovery emails are stored encrypted (AES-256-GCM) for
/// delivery, plus a separate keyed hash for enumeration-safe lookup and per-email
/// rate limiting. The plaintext email is never logged, never returned by any
/// public endpoint, and never appears in /health or /ops.

/// The 32-byte key, base64 in SUHO_EMAIL_ENC_KEY. Read lazily so the guardian
/// still boots when the key is absent; the recovery paths are the only callers
/// and they fail loudly if it is missing.
let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const b64 = process.env.SUHO_EMAIL_ENC_KEY;
  if (!b64) throw new Error("SUHO_EMAIL_ENC_KEY is not set");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("SUHO_EMAIL_ENC_KEY must decode to 32 bytes (AES-256)");
  cachedKey = k;
  return k;
}

/// Trim + lowercase. Emails are treated case-insensitively so re-binding the
/// same address in a different case is recognised as the same email.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/// Deterministic keyed hash (HMAC-SHA256) of the normalized email. Used as the
/// lookup/rate-limit key so the plaintext never has to be compared. Keyed, so it
/// is not a plain dictionary-able digest.
export function emailHash(email: string): string {
  return createHmac("sha256", key()).update(normalizeEmail(email)).digest("hex");
}

/// AES-256-GCM. Output is `iv.tag.ciphertext`, each base64. A fresh random IV per
/// call, so the same email encrypts to different ciphertext each time.
export function encryptEmail(email: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(normalizeEmail(email), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

export function decryptEmail(blob: string): string {
  const [ivB64, tagB64, ctB64] = blob.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed encrypted email");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
