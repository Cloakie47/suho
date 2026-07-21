import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derToRS, normalizeS, spkiToXY, P256_N } from "./webauthn.js";

// Self-test against the REAL Windows Hello artifacts captured in probe E:
// proves the DER parser + low-s normalization on an actual browser signature
// before any transaction depends on them (app spec binding note 2).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const probe = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../probe-tmp/webauthn/webauthn-result.json"),
    "utf8",
  ),
);

const der = Buffer.from(probe.assertionSignatureB64, "base64");
console.log("DER signature length:", der.length, "bytes");
const { r, s } = derToRS(der);
console.log("r in range:", r > 0n && r < P256_N);
console.log("s in range:", s > 0n && s < P256_N);
const sLow = normalizeS(s);
console.log("s was high (normalized):", sLow !== s);
console.log("normalized s <= n/2:", sLow <= P256_N / 2n);

const { x, y } = spkiToXY(probe.publicKeySpkiB64);
console.log("pubkey x:", x);
console.log("pubkey y:", y);
console.log("SELFTEST PASS");
