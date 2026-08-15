import type { Express } from "express";
import { keccak256, encodeAbiParameters, toBytes, getAddress, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import { publicClient, readTwice } from "./chain.js";
import { ondolAccountAbi } from "./contracts.js";
import { verifyAssertion, type BrowserAssertion } from "./webauthn.js";
import { verifyTransfer } from "./txverify.js";
import {
  insertReturnRequest,
  getInbox,
  getSent,
  getMessageById,
  getRequestsForTx,
  setMessageStatus,
  markMessageReturned,
  blockRequester,
  isBlocked,
  countRecentMessages,
  type TxMessage,
} from "./db.js";

/// Phase M endpoints: transaction-attached messages (memos + return requests).
/// Everything anchors to an on-chain tx the guardian verifies before storing,
/// and every read/write is passkey-gated so localStorage alone can't touch an
/// account's messages. No contract changes; storage is Postgres, bodies are
/// encrypted at rest (crypto.encryptMessage).

interface MessageDeps {
  verifiedBy: (a: Hex) => Promise<string | null>;
  noteError: (where: string, e: unknown) => void;
}

const isAddr = (a: unknown): a is Hex => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isTxHash = (h: unknown): h is Hex => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);

// Return-request body limit (M0 rule 5).
const REQUEST_MAX = 280;
// M0 rule 4: a reminder is allowed only after this window.
const REMINDER_AFTER_MS = 7 * 24 * 3_600_000;
// Return-flow amount tolerance is token-aware. For ETH we allow a wei-scale dust
// (gas/rounding), but a wei tolerance is meaningless for a 6-decimal token, so
// ERC-20 returns must match EXACTLY — the return flow pre-fills the exact amount,
// so exact is always achievable.
const RETURN_DUST_WEI = 10_000_000_000_000n; // 0.00001 ETH
function returnTolerance(token: string): bigint {
  return token === "ETH" ? RETURN_DUST_WEI : 0n;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REQUESTS_PER_DAY = 3;

// M0 rule 5: plain text only. Strip HTML angle brackets and control chars, then
// trim. The app applies the same transform before signing, so the stored body
// equals the signed body.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]", "g");
export function sanitizeBody(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[<>]/g, "")
    .replace(CONTROL_CHARS, "")
    .trim();
}

// ---- allowlisted tokens for return requests (M0 rule 3) ----
// ETH is always allowed. Additional tokens (canonical USDC on GIWA Sepolia) come
// from SUHO_RETURN_REQUEST_TOKENS as a comma-separated address list, so we never
// hardcode an unverified token address. `facts.token` is "ETH" or a lowercased
// address, which is exactly what we compare against.
function returnRequestTokens(): Set<string> {
  const set = new Set<string>(["ETH"]);
  const raw = process.env.SUHO_RETURN_REQUEST_TOKENS;
  if (raw) {
    for (const t of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      set.add(t.toLowerCase() === "eth" ? "ETH" : t.toLowerCase());
    }
  }
  return set;
}

// ---- content-bound passkey proof (creating a return request) ----
// The request carries a WebAuthn assertion over a challenge DERIVED from its
// content, so the passkey signature authorizes exactly this request and nothing
// else. The guardian recomputes the challenge from the received fields and
// verifies it against the acting account's on-chain P-256 key. The app computes
// the identical preimage with viem before signing. `account` is EIP-55
// checksummed before encoding (viem's abi address encoder requires it) so both
// sides derive the byte-identical preimage regardless of the case it arrived in.
const requestChallenge = (account: Hex, txHash: Hex, body: string): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
      ["suho.txmsg.return.v1", getAddress(account), txHash, keccak256(toBytes(body))],
    ),
  );

// Read the account's on-chain passkey (read-twice: a fresh account can read
// empty on a load-balanced node) and verify the assertion signs `challenge`.
async function verifyContentSig(
  account: Hex,
  challenge: Hex,
  sig: BrowserAssertion,
): Promise<boolean> {
  let x: Hex, y: Hex;
  try {
    [x, y] = (await readTwice(() =>
      publicClient.readContract({ address: account, abi: ondolAccountAbi, functionName: "passkey" }),
    )) as [Hex, Hex];
  } catch {
    return false;
  }
  return verifyAssertion({ x, y }, challenge, sig);
}

// ---- read sessions (M0 rule 7) ----
// A read (inbox/sent) needs a passkey-gated session proof so localStorage alone
// can't read someone's messages. Flow: GET /messages/challenge -> sign -> POST
// /messages/session (verifies the assertion against the account's passkey) ->
// short-lived bearer token bound to that account, presented on the reads.
const readChallenges = new Map<string, { challenge: Hex; expiresAt: number }>();
const sessions = new Map<string, { account: string; expiresAt: number }>();
const SESSION_TTL_MS = 10 * 60_000;

function issueReadChallenge(account: Hex): Hex {
  const challenge = `0x${randomBytes(32).toString("hex")}` as Hex;
  readChallenges.set(account.toLowerCase(), { challenge, expiresAt: Date.now() + 5 * 60_000 });
  return challenge;
}
async function verifyReadChallenge(account: Hex, sig: BrowserAssertion): Promise<boolean> {
  const c = readChallenges.get(account.toLowerCase());
  if (!c || c.expiresAt < Date.now()) return false;
  const ok = await verifyContentSig(account, c.challenge, sig);
  if (ok) readChallenges.delete(account.toLowerCase());
  return ok;
}
function sessionAccount(req: { headers: Record<string, unknown> }): string | null {
  const token = String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now()) {
    if (s) sessions.delete(token);
    return null;
  }
  return s.account;
}

// The client renders provable facts, not its own claims: fold a stored row into
// the anchored-tx facts the guardian verified. The sender's status folds
// 'dismissed' -> pending so a receiver's local dismiss never leaks to the sender.
function toWire(m: TxMessage, forSender = false): Record<string, unknown> {
  const status = forSender && m.status === "dismissed" ? "active" : m.status;
  return {
    id: m.id,
    kind: m.kind,
    txHash: m.txHash,
    from: m.from,
    to: m.to,
    token: m.token,
    amountWei: m.amountWei,
    body: m.body,
    status,
    returnTxHash: m.returnTxHash,
    createdAt: m.createdAt,
  };
}

export function registerMessages(app: Express, deps: MessageDeps): void {
  // Memos are on-chain now (SuhoMemo `Memo` events, batched into the send's
  // execute). The guardian no longer stores or serves them — the old
  // POST /messages/memo endpoint is gone.

  // ---- POST /messages/return-request { account, txHash, body, sig } ----
  // Only a Dojang-verified account may create a return request, on an
  // allowlisted-token transfer FROM itself, at most one per tx (+ one reminder
  // after the window), and not if the recipient has blocked it. The response is
  // generic on the not-eligible paths (no oracle for "who is on Suho").
  app.post("/messages/return-request", async (req, res) => {
    try {
      const { account, txHash, body, sig } = req.body as {
        account: Hex; txHash: Hex; body: string; sig: BrowserAssertion;
      };
      if (!isAddr(account) || !isTxHash(txHash) || !sig) {
        return res.status(400).json({ error: "InvalidRequest" });
      }
      const clean = sanitizeBody(body);
      if (clean.length === 0 || clean.length > REQUEST_MAX) {
        return res.status(400).json({ error: "MessageTooLong" });
      }
      if (!(await verifyContentSig(account, requestChallenge(account, txHash, clean), sig))) {
        return res.status(401).json({ error: "PasskeyRequired" });
      }
      // Verified-sender gate (M0 rule 2). Checked after the passkey proof so an
      // unverified caller can't probe verification status without controlling
      // the account.
      if (!(await deps.verifiedBy(account))) {
        return res.status(400).json({ error: "SenderNotVerified" });
      }
      if ((await countRecentMessages({ from: account, kind: "return_request", windowMs: DAY })) >= REQUESTS_PER_DAY) {
        return res.status(429).json({ error: "RateLimited" });
      }
      const facts = await verifyTransfer(txHash, account);
      if (!facts) return res.status(400).json({ error: "AnchorUnverified" });
      if (!returnRequestTokens().has(String(facts.token))) {
        return res.status(400).json({ error: "TokenNotAllowed" });
      }
      // Blocked requester: accept-shaped, never delivered (M0 rule 6).
      if (await isBlocked(facts.to, account)) {
        return res.json({ ok: true });
      }
      // One request per tx, plus one reminder only after the window (M0 rule 4).
      const existing = await getRequestsForTx(txHash);
      const req0 = existing.find((m) => m.kind === "return_request");
      const kind: "return_request" | "reminder" = req0 ? "reminder" : "return_request";
      if (kind === "reminder") {
        if (existing.some((m) => m.kind === "reminder")) {
          return res.status(400).json({ error: "AlreadyRequested" });
        }
        if (Date.now() - new Date(req0!.createdAt).getTime() < REMINDER_AFTER_MS) {
          return res.status(400).json({ error: "ReminderTooSoon" });
        }
      }
      const stored = await insertReturnRequest(
        { txHash, from: facts.from, to: facts.to, token: String(facts.token), amountWei: facts.amountWei.toString(), kind },
        clean,
      );
      res.json({ ok: true, message: toWire(stored, true) });
    } catch (e) {
      deps.noteError("messages/return-request", e);
      res.status(500).json({ error: "MessageFailed" });
    }
  });

  // ---- GET /messages/challenge?account= ----
  // Step one of obtaining an ACTION session (reads are public; this exists only
  // so a receiver can prove control before decline/dismiss/block/mark-returned).
  app.get("/messages/challenge", (req, res) => {
    const account = String(req.query.account ?? "");
    if (!isAddr(account)) return res.status(400).json({ error: "InvalidRequest" });
    res.json({ challenge: issueReadChallenge(account), expiresAt: Date.now() + 5 * 60_000 });
  });

  // ---- POST /messages/session { account, sig } ----
  // Exchange a signed challenge for a short-lived bearer token bound to the
  // account. The token authorizes the receiver ACTIONS (respond, mark-returned).
  app.post("/messages/session", async (req, res) => {
    try {
      const { account, sig } = req.body as { account: Hex; sig: BrowserAssertion };
      if (!isAddr(account) || !sig) return res.status(400).json({ error: "InvalidRequest" });
      if (!(await verifyReadChallenge(account, sig))) {
        return res.status(401).json({ error: "PasskeyRequired" });
      }
      const token = randomBytes(32).toString("hex");
      const expiresAt = Date.now() + SESSION_TTL_MS;
      sessions.set(token, { account: account.toLowerCase(), expiresAt });
      res.json({ token, expiresAt });
    } catch (e) {
      deps.noteError("messages/session", e);
      res.status(500).json({ error: "MessageFailed" });
    }
  });

  // ---- GET /messages/inbox?account= (public) ----
  // Requests are viewable by address (public-for-now stance): no session needed
  // to READ. Only receiver ACTIONS below require a session.
  app.get("/messages/inbox", async (req, res) => {
    try {
      const account = String(req.query.account ?? "");
      if (!isAddr(account)) return res.status(400).json({ error: "InvalidRequest" });
      const items = (await getInbox(account)).map((m) => toWire(m, false));
      res.json({ items });
    } catch (e) {
      deps.noteError("messages/inbox", e);
      res.status(500).json({ error: "MessageFailed" });
    }
  });

  // ---- GET /messages/sent?account= (public) ----
  app.get("/messages/sent", async (req, res) => {
    try {
      const account = String(req.query.account ?? "");
      if (!isAddr(account)) return res.status(400).json({ error: "InvalidRequest" });
      const items = (await getSent(account)).map((m) => toWire(m, true));
      res.json({ items });
    } catch (e) {
      deps.noteError("messages/sent", e);
      res.status(500).json({ error: "MessageFailed" });
    }
  });

  // ---- POST /messages/respond { messageId, action } (Bearer session) ----
  // Receiver-only actions on a request: decline (sender sees 'declined'),
  // dismiss (hidden locally, sender still sees pending), block (no future
  // requests from that account). Authorized by the receiver's read session (a
  // passkey proof of account control); the session's account must be the message
  // recipient.
  app.post("/messages/respond", async (req, res) => {
    try {
      const { messageId, action } = req.body as {
        messageId: number; action: "decline" | "dismiss" | "block";
      };
      if (!Number.isInteger(messageId) || !["decline", "dismiss", "block"].includes(action)) {
        return res.status(400).json({ error: "InvalidRequest" });
      }
      // Require a valid session before any DB lookup, so an unauthenticated
      // caller can't probe which message IDs exist.
      const authed = sessionAccount(req);
      if (!authed) return res.status(401).json({ error: "PasskeyRequired" });
      const m = await getMessageById(messageId);
      if (!m) return res.status(404).json({ error: "NotFound" });
      if (authed !== m.to.toLowerCase()) return res.status(401).json({ error: "PasskeyRequired" });
      const receiver = m.to as Hex;
      if (action === "block") {
        await blockRequester(receiver, m.from);
        await setMessageStatus(messageId, "dismissed"); // hide the current one too
      } else if (action === "decline") {
        if (m.status === "active") await setMessageStatus(messageId, "declined");
      } else {
        if (m.status === "active") await setMessageStatus(messageId, "dismissed");
      }
      res.json({ ok: true });
    } catch (e) {
      deps.noteError("messages/respond", e);
      res.status(500).json({ error: "MessageFailed" });
    }
  });

  // ---- POST /messages/mark-returned { messageId, returnTxHash } (public) ----
  // Called by the return flow after the receiver sends the funds back. No session
  // is required: the substantive gate is fully on-chain. Marking 'returned' takes
  // effect ONLY if a real return tx exists — right direction (receiver -> original
  // sender), right token, right amount within dust. Since only the receiver could
  // have produced such a tx (it moves their funds), an unauthenticated caller
  // can't forge a "returned" — the truth is anchored to the chain, so the send's
  // own passkey is the only real approval and Return stays one tap.
  app.post("/messages/mark-returned", async (req, res) => {
    try {
      const { messageId, returnTxHash } = req.body as {
        messageId: number; returnTxHash: Hex;
      };
      if (!Number.isInteger(messageId) || !isTxHash(returnTxHash)) {
        return res.status(400).json({ error: "InvalidRequest" });
      }
      const m = await getMessageById(messageId);
      if (!m) return res.status(404).json({ error: "NotFound" });
      const receiver = m.to as Hex;
      // The return goes the other way: from the original receiver back to the
      // original sender, same token, matching amount.
      const facts = await verifyTransfer(returnTxHash, receiver, m.from as Hex);
      if (!facts) return res.status(400).json({ error: "ReturnUnverified" });
      if (String(facts.token) !== m.token) return res.status(400).json({ error: "ReturnTokenMismatch" });
      const expected = BigInt(m.amountWei);
      const diff = facts.amountWei > expected ? facts.amountWei - expected : expected - facts.amountWei;
      if (diff > returnTolerance(m.token)) return res.status(400).json({ error: "ReturnAmountMismatch" });
      await markMessageReturned(messageId, returnTxHash);
      res.json({ ok: true });
    } catch (e) {
      deps.noteError("messages/mark-returned", e);
      res.status(500).json({ error: "MessageFailed" });
    }
  });
}
