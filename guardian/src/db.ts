import "./env.js"; // ensure DATABASE_URL is loaded (db:init runs without index.ts)
import pg from "pg";
import { encryptEmail, emailHash } from "./crypto.js";

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
  `);
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

export async function hasRecovery(address: string): Promise<boolean> {
  return (await getRecovery(address)) !== null;
}

/// Retention: recovery data exists only to deliver recovery, and is removed with
/// the account.
export async function removeAccount(address: string): Promise<void> {
  await db().query(`DELETE FROM accounts WHERE address = $1`, [addr(address)]);
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
