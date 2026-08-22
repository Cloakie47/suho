import type { Express } from "express";
import { keccak256, encodePacked, type Hex } from "viem";
import { randomInt } from "node:crypto";
import { publicClient, relayerWallet } from "./chain.js";
import { ADDR, ondolV4Abi, suhoCodeAttesterAbi } from "./contracts.js";
import type { BrowserAssertion } from "./webauthn.js";
import { getRecovery, recordEmailEvent, countRecentEmailEvents } from "./db.js";
import { decryptEmail } from "./crypto.js";
import { sendOpCode } from "./email.js";

/// Phase SEC 2.3 guardian wiring for the OndolAccountV4 email second factor.
///
/// The load-bearing policy: a sensitive-op code (setGuard/upgrade/disable) or a
/// large-send code is minted ONLY to the account's registered recovery email and
/// is NEVER returned in any HTTP response. A passkey-only attacker can trigger a
/// request (it is passkey-gated to stop spam) but cannot read the emailed code,
/// so the code is a genuine independent factor. Requires a registered recovery
/// email; refused cleanly otherwise.

const HOUR = 3_600_000;
const OP_MAX_PER_HOUR = 5;
export const isAddr = (a: unknown): a is Hex => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const sixDigit = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

// bytes32(v) as the contract renders it: 0x + 64 lowercase hex, zero-padded.
export const b32 = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

/// Read the V4 lock state. The staticcall reverts on a V1/V2/V3 account (no such
/// function); treat that as "not locked, nonce 0", so pre-V4 accounts behave
/// exactly as before.
export async function readLockState(
  account: Hex,
): Promise<{ sensitiveOpLock: boolean; emailLargeSendLock: boolean; sensitiveOpNonce: bigint }> {
  try {
    const [lock, sendLock, nonce] = await Promise.all([
      publicClient.readContract({ address: account, abi: ondolV4Abi, functionName: "sensitiveOpLock" }),
      publicClient.readContract({ address: account, abi: ondolV4Abi, functionName: "emailLargeSendLock" }),
      publicClient.readContract({ address: account, abi: ondolV4Abi, functionName: "sensitiveOpNonce" }),
    ]);
    return { sensitiveOpLock: lock, emailLargeSendLock: sendLock, sensitiveOpNonce: nonce };
  } catch {
    return { sensitiveOpLock: false, emailLargeSendLock: false, sensitiveOpNonce: 0n };
  }
}

// Domains, byte-identical to what OndolAccountV4 builds via HexStrings.
const opDomain = (account: string, op: string, param: string, nonce: bigint) =>
  `suho.op:${op}:${account.toLowerCase()}:${param.toLowerCase()}:${b32(nonce)}`;
const disableDomain = (account: string, kind: string, nonce: bigint) =>
  `suho.op:${kind}:${account.toLowerCase()}:${b32(nonce)}`;
const sendDomain = (account: string, recipient: string, value: bigint) =>
  `suho.send:${account.toLowerCase()}:${recipient.toLowerCase()}:${b32(value)}`;

function opLabel(op: string, param?: string): string {
  if (op === "setguard") return `change the transfer guard to ${param}`;
  if (op === "upgrade") return `upgrade the account implementation to ${param}`;
  if (op === "disablelock") return "turn off extra protection (the control lock)";
  if (op === "disablesendlock") return "turn off the large-send email check";
  return op;
}

/// Mint a single-use code committing to (account, domain, code), on chain via the
/// issuer key, then email it to `deliverTo`. The code is never returned.
export async function mintAndEmail(account: Hex, domain: string, what: string, deliverTo: string): Promise<void> {
  const code = sixDigit();
  const codeHash = keccak256(encodePacked(["address", "string", "string"], [account, domain, code]));
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 600);
  const txHash = await relayerWallet.writeContract({
    address: ADDR.suhoCodeAttester,
    abi: suhoCodeAttesterAbi,
    functionName: "issueCode",
    args: [account, domain, codeHash, expiry],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  await sendOpCode(deliverTo, code, what, account);
}

interface Deps {
  passGate: (purpose: string, account: Hex, webauthn: BrowserAssertion) => Promise<boolean>;
  issueGate: (purpose: string, account: string) => Hex;
  noteError: (where: string, e: unknown) => void;
}

export function registerV4Locks(app: Express, deps: Deps): void {
  // ---- GET /op/challenge?account= ----
  app.get("/op/challenge", (req, res) => {
    const account = String(req.query.account ?? "");
    if (!isAddr(account)) return res.status(400).json({ error: "InvalidRequest" });
    res.json({ challenge: deps.issueGate("op", account), expiresAt: Date.now() + 5 * 60_000 });
  });

  // ---- POST /op/request-code { account, op, param?, webauthn } ----
  // op in { setguard, upgrade, disablelock, disablesendlock }.
  app.post("/op/request-code", async (req, res) => {
    try {
      const { account, op, param, webauthn } = req.body as {
        account: Hex; op: string; param?: Hex; webauthn: BrowserAssertion;
      };
      const OPS = ["setguard", "upgrade", "disablelock", "disablesendlock"];
      if (!isAddr(account) || !OPS.includes(op) || !webauthn) {
        return res.status(400).json({ error: "InvalidRequest" });
      }
      const needsParam = op === "setguard" || op === "upgrade";
      if (needsParam && !isAddr(param)) return res.status(400).json({ error: "InvalidRequest" });
      if (!(await deps.passGate("op", account, webauthn))) {
        return res.status(401).json({ error: "PasskeyRequired" });
      }
      const rec = await getRecovery(account);
      if (!rec) return res.status(400).json({ error: "NoRecoveryEmail" });
      if ((await countRecentEmailEvents({ address: account, kind: "op", windowMs: HOUR })) >= OP_MAX_PER_HOUR) {
        return res.status(429).json({ error: "RateLimited" });
      }
      const { sensitiveOpNonce } = await readLockState(account);
      const domain = needsParam
        ? opDomain(account, op, param as string, sensitiveOpNonce)
        : disableDomain(account, op, sensitiveOpNonce);
      await mintAndEmail(account, domain, opLabel(op, param), decryptEmail(rec.encrypted));
      await recordEmailEvent(account, rec.hash, "op");
      res.json({ ok: true });
    } catch (e) {
      deps.noteError("op/request-code", e);
      res.status(500).json({ error: "OpCodeFailed" });
    }
  });

  // ---- POST /op/request-send-code { account, recipient, value, webauthn } ----
  app.post("/op/request-send-code", async (req, res) => {
    try {
      const { account, recipient, value, webauthn } = req.body as {
        account: Hex; recipient: Hex; value: string; webauthn: BrowserAssertion;
      };
      if (!isAddr(account) || !isAddr(recipient) || typeof value !== "string" || !webauthn) {
        return res.status(400).json({ error: "InvalidRequest" });
      }
      let wei: bigint;
      try {
        wei = BigInt(value);
      } catch {
        return res.status(400).json({ error: "InvalidRequest" });
      }
      if (!(await deps.passGate("op", account, webauthn))) {
        return res.status(401).json({ error: "PasskeyRequired" });
      }
      const rec = await getRecovery(account);
      if (!rec) return res.status(400).json({ error: "NoRecoveryEmail" });
      if ((await countRecentEmailEvents({ address: account, kind: "op", windowMs: HOUR })) >= OP_MAX_PER_HOUR) {
        return res.status(429).json({ error: "RateLimited" });
      }
      const domain = sendDomain(account, recipient, wei);
      const eth = (Number(wei) / 1e18).toFixed(6);
      await mintAndEmail(account, domain, `send ${eth} ETH to ${recipient}`, decryptEmail(rec.encrypted));
      await recordEmailEvent(account, rec.hash, "op");
      res.json({ ok: true });
    } catch (e) {
      deps.noteError("op/request-send-code", e);
      res.status(500).json({ error: "OpCodeFailed" });
    }
  });
}
