import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/// P3: banner is pure ASCII by construction — no box-drawing characters, so it
/// renders clean in any Windows console codepage (cp850/cp949/UTF-8 alike).
/// Codes are also appended to guardian/codes.log (gitignored, testnet-only) so
/// a lost console window never strands an issued code again.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODES_LOG = path.resolve(__dirname, "../codes.log");

export function printCodeBanner(
  kind: "RECOVERY" | "TRANSFER",
  subject: string,
  code: string,
): void {
  const width = 50;
  const bar = "+" + "-".repeat(width) + "+";
  const row = (s = "") => "|" + s.padEnd(width) + "|";
  const center = (s: string) =>
    row(" ".repeat(Math.max(0, Math.floor((width - s.length) / 2))) + s);

  const banner = [
    "",
    bar,
    center("UPBIT  VERIFICATION  SERVICE"),
    row(),
    center(kind === "RECOVERY" ? "Account recovery code for" : "Transfer verification code for"),
    center(subject),
    row(),
    center(">>>   " + code.slice(0, 3) + " " + code.slice(3) + "   <<<"),
    row(),
    center("Valid for 10 minutes."),
    center("Never share this code with anyone."),
    bar,
    "",
  ].join("\n");

  console.log(banner);
  try {
    fs.appendFileSync(CODES_LOG, `[${new Date().toISOString()}] ${kind} ${subject} code=${code}\n`);
  } catch {
    // log failure must never block issuance
  }
}
