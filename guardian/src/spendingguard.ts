import type { Express } from "express";
import { type Hex } from "viem";
import { publicClient } from "./chain.js";
import { ADDR, spendingGuardAbi } from "./contracts.js";
import { getRecovery, recordEmailEvent, countRecentEmailEvents } from "./db.js";
import { decryptEmail } from "./crypto.js";
import { mintAndEmail, b32, isAddr } from "./v4locks.js";

/// Bank-model second factor. An over-limit send or a limit raise needs a code that
/// only the account's registered recovery email receives — a genuine independent
/// factor a device thief can't read. The code is bound to the exact action and is
/// consumed by a passkey-SIGNED execute (the send, or setLimits); that signature is
/// the possession factor, so requesting the code is deliberately NOT passkey-gated —
/// a second assertion of the same key would be theater, not a boundary. Abuse of the
/// email budget is bounded by a per-account throttle instead. Domains are
/// byte-identical to what OndolSpendingGuard builds via HexStrings, and the nonce is
/// read from the GUARD (its per-account opNonce), not the account, so codes can't be
/// pre-minted across a consumed one.

const HOUR = 3_600_000;
const MAX_PER_HOUR = 5;

async function guardNonce(account: Hex): Promise<bigint> {
  const n = await publicClient.readContract({
    address: ADDR.ondolSpendingGuard,
    abi: spendingGuardAbi,
    functionName: "opNonce",
    args: [account],
  });
  return BigInt(n);
}

// suho.spend:<account>:<recipient>:<valueB32>:<nonceB32>
const spendDomain = (account: string, recipient: string, value: bigint, nonce: bigint) =>
  `suho.spend:${account.toLowerCase()}:${recipient.toLowerCase()}:${b32(value)}:${b32(nonce)}`;
// suho.limit:<account>:<perTxB32>:<dailyB32>:<nonceB32>
const limitDomain = (account: string, perTx: bigint, daily: bigint, nonce: bigint) =>
  `suho.limit:${account.toLowerCase()}:${b32(perTx)}:${b32(daily)}:${b32(nonce)}`;

const eth = (wei: bigint) => (Number(wei) / 1e18).toFixed(6);

interface Deps {
  noteError: (where: string, e: unknown) => void;
}

export function registerSpendingGuard(app: Express, deps: Deps): void {
  // ---- POST /spend/request-code { account, recipient, value } ----
  // Authorize an over-limit ETH send. Code bound to (account, recipient, value, nonce).
  // Not passkey-gated: the send that consumes this code carries the signature.
  app.post("/spend/request-code", async (req, res) => {
    try {
      const { account, recipient, value } = req.body as {
        account: Hex;
        recipient: Hex;
        value: string;
      };
      if (!isAddr(account) || !isAddr(recipient) || typeof value !== "string") {
        return res.status(400).json({ error: "InvalidRequest" });
      }
      let wei: bigint;
      try {
        wei = BigInt(value);
      } catch {
        return res.status(400).json({ error: "InvalidRequest" });
      }
      const rec = await getRecovery(account);
      if (!rec) return res.status(400).json({ error: "NoRecoveryEmail" });
      if ((await countRecentEmailEvents({ address: account, kind: "op", windowMs: HOUR })) >= MAX_PER_HOUR) {
        return res.status(429).json({ error: "RateLimited" });
      }
      const nonce = await guardNonce(account);
      const domain = spendDomain(account, recipient, wei, nonce);
      await mintAndEmail(account, domain, `send ${eth(wei)} ETH to ${recipient}`, decryptEmail(rec.encrypted));
      await recordEmailEvent(account, rec.hash, "op");
      res.json({ ok: true });
    } catch (e) {
      deps.noteError("spend/request-code", e);
      res.status(500).json({ error: "OpCodeFailed" });
    }
  });

  // ---- POST /limit/request-code { account, perTx, daily } ----
  // Authorize a limit RAISE (or disable). Code bound to (account, perTx, daily, nonce).
  // Not passkey-gated: the setLimits that consumes this code carries the signature.
  app.post("/limit/request-code", async (req, res) => {
    try {
      const { account, perTx, daily } = req.body as {
        account: Hex;
        perTx: string;
        daily: string;
      };
      if (!isAddr(account) || typeof perTx !== "string" || typeof daily !== "string") {
        return res.status(400).json({ error: "InvalidRequest" });
      }
      let p: bigint, d: bigint;
      try {
        p = BigInt(perTx);
        d = BigInt(daily);
      } catch {
        return res.status(400).json({ error: "InvalidRequest" });
      }
      const rec = await getRecovery(account);
      if (!rec) return res.status(400).json({ error: "NoRecoveryEmail" });
      if ((await countRecentEmailEvents({ address: account, kind: "op", windowMs: HOUR })) >= MAX_PER_HOUR) {
        return res.status(429).json({ error: "RateLimited" });
      }
      const nonce = await guardNonce(account);
      const domain = limitDomain(account, p, d, nonce);
      await mintAndEmail(
        account,
        domain,
        `set your limits to ${eth(p)} ETH per send and ${eth(d)} ETH per day`,
        decryptEmail(rec.encrypted),
      );
      await recordEmailEvent(account, rec.hash, "op");
      res.json({ ok: true });
    } catch (e) {
      deps.noteError("limit/request-code", e);
      res.status(500).json({ error: "OpCodeFailed" });
    }
  });
}
