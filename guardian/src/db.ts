import "./env.js"; // ensure DATABASE_URL is loaded (db:init runs without index.ts)
import pg from "pg";
import { encryptEmail, emailHash, encryptMessage, decryptMessage } from "./crypto.js";

/// Phase H persistence (Railway Postgres). Connection string from DATABASE_URL,
/// never committed. The pool is created lazily so the guardian still boots when
/// the database is absent; the recovery paths are the only callers.

let pool: pg.Pool | null = null;
function db(): pg.Pool {
  if (pool) return pool;
  // Railway's internal host (postgres.railway.internal) only resolves inside
  // Railway. For local dev set DATABASE_PUBLIC_URL to the public proxy URL; it
  // takes precedence when present. On Railway only DATABASE_URL (internal) is
  // set, so the internal host is used there.
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  // Managed Postgres (Railway) terminates TLS; allow it without a local CA.
  const ssl = /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: false };
  pool = new pg.Pool({ connectionString, ssl, max: 5, idleTimeoutMillis: 30_000 });
  return pool;
}

/// Open a few connections up front. Over Railway's public proxy each fresh
/// connection costs a ~3s TLS handshake; pre-warming keeps request latency down
/// in local dev. On Railway's internal network this is already fast.
export async function warmPool(n = 3): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => db().query("SELECT 1")));
}

const addr = (a: string) => a.toLowerCase();

/// Idempotent schema. Run at boot (H3/H4) or via `npm run db:init`.
export async function initDb(): Promise<void> {
  await db().query(`
    CREATE TABLE IF NOT EXISTS accounts (
      address                  TEXT PRIMARY KEY,
      recovery_email_hash      TEXT,        -- HMAC-SHA256(normalized email); enumeration-safe lookup
      recovery_email_encrypted TEXT,        -- AES-256-GCM ciphertext; for delivery only
      verified_at              TIMESTAMPTZ, -- when the email binding was confirmed
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS accounts_email_hash_idx ON accounts (recovery_email_hash);

    CREATE TABLE IF NOT EXISTS email_events (
      id         BIGSERIAL PRIMARY KEY,
      address    TEXT NOT NULL,
      email_hash TEXT,                       -- for per-email rate limiting; never the plaintext
      kind       TEXT NOT NULL,              -- 'confirm' | 'arise'
      sent_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS email_events_addr_idx  ON email_events (address, kind, sent_at);
    CREATE INDEX IF NOT EXISTS email_events_hash_idx  ON email_events (email_hash, kind, sent_at);

    CREATE TABLE IF NOT EXISTS ops_audit (
      id      BIGSERIAL PRIMARY KEY,
      action  TEXT NOT NULL,
      address TEXT,
      at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Phase M: transaction-attached messages. Every row anchors to an on-chain
    -- tx the guardian verified before storing. Bodies are AES-256-GCM at rest
    -- (crypto.encryptMessage). One row per (tx_hash, kind): the unique index
    -- gives us "one return_request per tx, plus at most one reminder" for free
    -- (M0 rule 4). Memos are NOT stored here anymore — they are on-chain SuhoMemo
    -- events (Phase M revision); this table holds return requests only.
    CREATE TABLE IF NOT EXISTS tx_messages (
      id             BIGSERIAL PRIMARY KEY,
      tx_hash        TEXT NOT NULL,
      kind           TEXT NOT NULL,   -- 'return_request' | 'reminder'
      from_address   TEXT NOT NULL,   -- sender account of the anchored tx
      to_address     TEXT NOT NULL,   -- recipient of the anchored tx
      token          TEXT NOT NULL,   -- 'ETH' or a lowercased token address
      amount_wei     TEXT NOT NULL,   -- exact wei as a decimal string
      body_encrypted TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active', -- active|declined|dismissed|returned
      return_tx_hash TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tx_messages_txhash_kind_idx ON tx_messages (tx_hash, kind);
    CREATE INDEX IF NOT EXISTS tx_messages_to_idx   ON tx_messages (to_address, created_at);
    CREATE INDEX IF NOT EXISTS tx_messages_from_idx ON tx_messages (from_address, created_at);

    -- A receiver can block a requester: no future requests from that account are
    -- delivered (M0 rule 6). Silent to the blocked party.
    CREATE TABLE IF NOT EXISTS message_blocks (
      blocker_address TEXT NOT NULL,
      blocked_address TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (blocker_address, blocked_address)
    );
  `);
}

// ---- Phase M: transaction-attached messages ----

export type MessageKind = "return_request" | "reminder";
export type MessageStatus = "active" | "declined" | "dismissed" | "returned";

export interface TxMessage {
  id: number;
  txHash: string;
  kind: MessageKind;
  from: string;
  to: string;
  token: string;
  amountWei: string;
  body: string; // decrypted; only ever returned to the two parties of the tx
  status: MessageStatus;
  returnTxHash: string | null;
  createdAt: string;
}

// pg returns snake_case columns; decrypt the body here so callers never touch
// ciphertext. Row shape is internal to this module.
function rowToMessage(r: Record<string, unknown>): TxMessage {
  return {
    id: Number(r.id),
    txHash: r.tx_hash as string,
    kind: r.kind as MessageKind,
    from: r.from_address as string,
    to: r.to_address as string,
    token: r.token as string,
    amountWei: r.amount_wei as string,
    body: decryptMessage(r.body_encrypted as string),
    status: r.status as MessageStatus,
    returnTxHash: (r.return_tx_hash as string) ?? null,
    createdAt: String(r.created_at),
  };
}

/// Store a return request or its one allowed reminder. Fails (throws on the
/// unique index) if a row of that kind already exists for the tx — the caller
/// checks first and maps duplicates to a clean sentence.
export async function insertReturnRequest(m: {
  txHash: string;
  from: string;
  to: string;
  token: string;
  amountWei: string;
  kind: "return_request" | "reminder";
}, body: string): Promise<TxMessage> {
  const { rows } = await db().query(
    `INSERT INTO tx_messages (tx_hash, kind, from_address, to_address, token, amount_wei, body_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [m.txHash.toLowerCase(), m.kind, addr(m.from), addr(m.to), m.token, m.amountWei, encryptMessage(body)],
  );
  return rowToMessage(rows[0]);
}

export async function getMessageById(id: number): Promise<TxMessage | null> {
  const { rows } = await db().query(`SELECT * FROM tx_messages WHERE id = $1`, [id]);
  return rows[0] ? rowToMessage(rows[0]) : null;
}

/// All request/reminder rows for a tx (memo excluded): lets the request handler
/// enforce "one request per tx + at most one reminder after the window".
export async function getRequestsForTx(txHash: string): Promise<TxMessage[]> {
  const { rows } = await db().query(
    `SELECT * FROM tx_messages
       WHERE tx_hash = $1 AND kind IN ('return_request','reminder')
       ORDER BY created_at ASC`,
    [txHash.toLowerCase()],
  );
  return rows.map(rowToMessage);
}

/// Receiver inbox: return requests where the account is the recipient (dismissed
/// hidden). Requests from a blocked sender are excluded (M0 rule 6).
export async function getInbox(account: string): Promise<TxMessage[]> {
  const { rows } = await db().query(
    `SELECT m.* FROM tx_messages m
       WHERE m.to_address = $1
         AND m.kind IN ('return_request','reminder')
         AND m.status <> 'dismissed'
         AND NOT EXISTS (
           SELECT 1 FROM message_blocks b
             WHERE b.blocker_address = m.to_address AND b.blocked_address = m.from_address
         )
       ORDER BY m.created_at DESC`,
    [addr(account)],
  );
  return rows.map(rowToMessage);
}

/// The return requests the account has sent, with status — for the "Return
/// requested / declined / returned" chip on its outgoing rows.
export async function getSent(account: string): Promise<TxMessage[]> {
  const { rows } = await db().query(
    `SELECT * FROM tx_messages
       WHERE from_address = $1 AND kind IN ('return_request','reminder')
       ORDER BY created_at DESC`,
    [addr(account)],
  );
  return rows.map(rowToMessage);
}

export async function setMessageStatus(id: number, status: MessageStatus): Promise<void> {
  await db().query(`UPDATE tx_messages SET status = $2 WHERE id = $1`, [id, status]);
}

export async function markMessageReturned(id: number, returnTxHash: string): Promise<void> {
  await db().query(
    `UPDATE tx_messages SET status = 'returned', return_tx_hash = $2 WHERE id = $1`,
    [id, returnTxHash.toLowerCase()],
  );
}

export async function blockRequester(blocker: string, blocked: string): Promise<void> {
  await db().query(
    `INSERT INTO message_blocks (blocker_address, blocked_address) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [addr(blocker), addr(blocked)],
  );
}

export async function isBlocked(blocker: string, blocked: string): Promise<boolean> {
  const { rows } = await db().query(
    `SELECT 1 FROM message_blocks WHERE blocker_address = $1 AND blocked_address = $2`,
    [addr(blocker), addr(blocked)],
  );
  return rows.length > 0;
}

/// Count an account's messages of a kind in a window — for the M0 rate limit
/// (3 return requests/day per account).
export async function countRecentMessages(opts: {
  from: string;
  kind: MessageKind;
  windowMs: number;
}): Promise<number> {
  const since = new Date(Date.now() - opts.windowMs);
  const { rows } = await db().query(
    `SELECT count(*)::int AS n FROM tx_messages
       WHERE from_address = $1 AND kind = $2 AND created_at >= $3`,
    [addr(opts.from), opts.kind, since],
  );
  return rows[0].n as number;
}

/// Bind (or replace) an account's recovery email, marking it verified now. The
/// email is encrypted for storage and hashed for lookup; the plaintext is not
/// retained.
export async function bindRecoveryEmail(address: string, email: string): Promise<void> {
  await db().query(
    `INSERT INTO accounts (address, recovery_email_hash, recovery_email_encrypted, verified_at)
       VALUES ($1, $2, $3, now())
     ON CONFLICT (address) DO UPDATE
       SET recovery_email_hash = EXCLUDED.recovery_email_hash,
           recovery_email_encrypted = EXCLUDED.recovery_email_encrypted,
           verified_at = now()`,
    [addr(address), emailHash(email), encryptEmail(email)],
  );
}

/// The stored recovery record for an account, or null. Callers decrypt the
/// ciphertext only at the moment of delivery.
export async function getRecovery(
  address: string,
): Promise<{ encrypted: string; hash: string } | null> {
  const { rows } = await db().query(
    `SELECT recovery_email_encrypted, recovery_email_hash FROM accounts
       WHERE address = $1 AND recovery_email_encrypted IS NOT NULL AND verified_at IS NOT NULL`,
    [addr(address)],
  );
  if (!rows[0]) return null;
  return { encrypted: rows[0].recovery_email_encrypted, hash: rows[0].recovery_email_hash };
}

export async function recordEmailEvent(
  address: string,
  emailHashHex: string | null,
  kind: "confirm" | "arise",
): Promise<void> {
  await db().query(`INSERT INTO email_events (address, email_hash, kind) VALUES ($1, $2, $3)`, [
    addr(address),
    emailHashHex,
    kind,
  ]);
}

/// Count recent email events for rate limiting — per account and/or per email
/// (by hash), within a window.
export async function countRecentEmailEvents(opts: {
  address?: string;
  emailHashHex?: string;
  kind: "confirm" | "arise";
  windowMs: number;
}): Promise<number> {
  const since = new Date(Date.now() - opts.windowMs);
  const conds = ["kind = $1", "sent_at >= $2"];
  const params: unknown[] = [opts.kind, since];
  if (opts.address) {
    params.push(addr(opts.address));
    conds.push(`address = $${params.length}`);
  }
  if (opts.emailHashHex) {
    params.push(opts.emailHashHex);
    conds.push(`email_hash = $${params.length}`);
  }
  const { rows } = await db().query(
    `SELECT count(*)::int AS n FROM email_events WHERE ${conds.join(" AND ")}`,
    params,
  );
  return rows[0].n as number;
}

/// Recent activity for the /ops view — addresses, kinds, timestamps only. Never
/// a code or an email.
export async function recentOps(limit = 25): Promise<{
  events: { address: string; kind: string; sent_at: string }[];
  audit: { action: string; address: string | null; at: string }[];
}> {
  const [ev, au] = await Promise.all([
    db().query(`SELECT address, kind, sent_at FROM email_events ORDER BY sent_at DESC LIMIT $1`, [limit]),
    db().query(`SELECT action, address, at FROM ops_audit ORDER BY at DESC LIMIT $1`, [limit]),
  ]);
  return { events: ev.rows, audit: au.rows };
}

export async function audit(action: string, address?: string): Promise<void> {
  await db().query(`INSERT INTO ops_audit (action, address) VALUES ($1, $2)`, [
    action,
    address ? addr(address) : null,
  ]);
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}
