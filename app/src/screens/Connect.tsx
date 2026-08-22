import { useCallback, useEffect, useRef, useState } from "react";
import { hashMessage, hashTypedData, isHex, hexToString, type Hex } from "viem";
import { api, type Status } from "../api";
import { activeAccount, credentialFor, hasAccount, rememberConnection } from "../config";
import { assertWithPasskey } from "../webauthn";
import { ensureV5 } from "../locks";
import { humanError, isUserCancel } from "../errors";
import { Seal, Spinner, shortAddr } from "../ui";
import { Onboard } from "./Onboard";

/// Horizon 1 / S1.2 — the /connect popup surface (Suho origin). A dApp's SDK opens
/// this in a 420x640 popup and speaks postMessage. THE SECURITY MODEL:
///   - The popup trusts only messages from window.opener that carry our envelope.
///   - The dApp origin it DISPLAYS and REPLIES TO comes from MessageEvent.origin of
///     the request — NEVER from the message payload (a payload origin is forgeable).
///   - Exactly one request is bound per popup; the reply targets that exact origin.
///   - If there is no Suho account on this device, onboarding runs right here, so a
///     first-time visitor completes sign-in without leaving the popup (the wedge).

// ---- wire protocol (mirrored in @suho/ondol) ----
const PROTO = 1;
type ReqMsg = { __suho: "req"; v: number; id: string; method: string; params: unknown[] };
type ResMsg = { __suho: "res"; v: number; id: string; result?: unknown; error?: { code: number; message: string } };

interface BoundRequest {
  id: string;
  method: string;
  params: unknown[];
  origin: string; // from MessageEvent.origin — the source of truth for the dApp identity
}

type Phase =
  | { k: "waiting" } // popup up, no request bound yet
  | { k: "onboarding" } // no account on device — onboard in place
  | { k: "review" } // request bound, account ready, awaiting the user
  | { k: "signing" }
  | { k: "preparing" } // transparent first-time V5 bridge (no jargon shown)
  | { k: "done"; label: string }
  | { k: "error"; message: string };

/// A decoded personal_sign message plus an optional SIWE reading.
interface DecodedMessage {
  text: string;
  siwe: { domain: string; statement?: string; nonce?: string; expiry?: string } | null;
}

function decodePersonalSign(raw: unknown): DecodedMessage {
  const m = String(raw ?? "");
  const text = isHex(m) ? safeHexToString(m as Hex) : m;
  return { text, siwe: parseSiwe(text) };
}

function safeHexToString(h: Hex): string {
  try {
    return hexToString(h);
  } catch {
    return h; // not UTF-8 — show the hex verbatim rather than guessing
  }
}

/// Minimal SIWE (EIP-4361) field extraction for a nicer render. Not a validator:
/// the message text is always shown verbatim too, so nothing is hidden.
function parseSiwe(text: string): DecodedMessage["siwe"] {
  const first = text.split("\n")[0] ?? "";
  const m = first.match(/^([^\s]+) wants you to sign in with your Ethereum account:?$/);
  if (!m) return null;
  const field = (label: string) => {
    const line = text.split("\n").find((l) => l.startsWith(`${label}:`));
    return line ? line.slice(label.length + 1).trim() : undefined;
  };
  const statementLine = text.split("\n").find((l, i) => i >= 3 && l.trim().length > 0 && !l.includes(":"));
  return {
    domain: m[1],
    statement: statementLine?.trim(),
    nonce: field("Nonce"),
    expiry: field("Expiration Time"),
  };
}

/// Flatten typed-data fields (one level of the primary type) into rows to render.
function typedRows(params: unknown[]): { domain: Record<string, unknown>; primaryType: string; rows: [string, string][] } | null {
  try {
    const td = typeof params[1] === "string" ? JSON.parse(params[1] as string) : (params[1] as Record<string, unknown>);
    const primaryType = String(td.primaryType);
    const message = (td.message ?? {}) as Record<string, unknown>;
    const rows = Object.entries(message).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)] as [string, string]);
    return { domain: (td.domain ?? {}) as Record<string, unknown>, primaryType, rows };
  } catch {
    return null;
  }
}

export function Connect() {
  const [phase, setPhase] = useState<Phase>({ k: "waiting" });
  const [req, setReq] = useState<BoundRequest | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const reqRef = useRef<BoundRequest | null>(null);
  const openerRef = useRef<Window | null>(null);

  /// Post the one response to the exact origin the request came from, then close.
  const respond = useCallback((payload: { result?: unknown; error?: { code: number; message: string } }) => {
    const b = reqRef.current;
    const opener = openerRef.current;
    if (!b || !opener) return;
    const msg: ResMsg = { __suho: "res", v: PROTO, id: b.id, ...payload };
    opener.postMessage(msg, b.origin); // EXPLICIT target origin — never "*"
  }, []);

  const finishOk = useCallback((result: unknown, label: string) => {
    respond({ result });
    setPhase({ k: "done", label });
    setTimeout(() => window.close(), 700);
  }, [respond]);

  const reject = useCallback((message: string, code = 4001) => {
    respond({ error: { code, message } });
    setTimeout(() => window.close(), 150);
  }, [respond]);

  // Bind the request from the opener; capture the dApp origin from the event.
  useEffect(() => {
    const opener = window.opener as Window | null;
    if (!opener) {
      setPhase({ k: "error", message: "Open this window from a dApp using the Suho SDK." });
      return;
    }
    openerRef.current = opener;

    const onMessage = (e: MessageEvent) => {
      const d = e.data as Partial<ReqMsg> | undefined;
      if (!d || d.__suho !== "req" || d.v !== PROTO) return;
      if (e.source !== opener) return; // only the window that opened us
      if (reqRef.current) return; // one request per popup, ever
      if (typeof d.id !== "string" || typeof d.method !== "string") return;
      const bound: BoundRequest = {
        id: d.id,
        method: d.method,
        params: Array.isArray(d.params) ? d.params : [],
        origin: e.origin, // <-- the ONLY source of the displayed/replied origin
      };
      reqRef.current = bound;
      setReq(bound);
    };
    window.addEventListener("message", onMessage);

    // If the user closes the popup, the SDK sees the close and rejects; we also
    // reject on unload so a same-tick close is unambiguous.
    const onUnload = () => {
      if (reqRef.current) respond({ error: { code: 4001, message: "User closed the Suho window" } });
    };
    window.addEventListener("beforeunload", onUnload);

    // Announce readiness. No secret in this ping; the opener validates our origin
    // and window identity before sending the request.
    const ready = { __suho: "ready", v: PROTO };
    opener.postMessage(ready, "*");

    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [respond]);

  // Once a request is bound, resolve the account (or route to onboarding).
  useEffect(() => {
    if (!req) return;
    if (!hasAccount()) {
      setPhase({ k: "onboarding" });
      return;
    }
    const account = activeAccount();
    if (!account) {
      setPhase({ k: "onboarding" });
      return;
    }
    let cancelled = false;
    setPhase({ k: "review" });
    // Retry the status read with backoff — a rate-limit blip must not leave the
    // account chip blank, and it must NEVER dead-end the request (signing decides
    // from ground truth in ensureV5, so a missing status only affects display).
    (async () => {
      for (let i = 0; i < 4 && !cancelled; i++) {
        try {
          const s = await api.status(account);
          if (!cancelled) setStatus(s);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [req]);

  const onOnboarded = useCallback(() => {
    // A fresh V5 account is now active; continue to the request review.
    setPhase({ k: "review" });
    const account = activeAccount();
    if (account) api.status(account).then(setStatus, () => {});
  }, []);

  // ---- approve handlers ----

  const account = activeAccount();

  const approveConnect = useCallback(() => {
    if (!req || !account) return;
    rememberConnection(req.origin, account);
    finishOk([account], "Connected");
  }, [req, account, finishOk]);

  const approveSign = useCallback(async () => {
    if (!req || !account) return;
    const credId = credentialFor(account);
    if (!credId) {
      setPhase({ k: "error", message: "This account has no passkey on this device. Open the Suho app to link it." });
      return;
    }
    try {
      // First-time bridge (invisible): if the account isn't V5 yet it can't do
      // ERC-1271, so silently move it there before signing. ensureV5 is idempotent
      // and reads GROUND TRUTH (the live proxy slot), so a stale /status can't make
      // it misfire; it fires `onBridge` only when a real upgrade runs (→ "Preparing
      // your account…"), and throws a plain sentence for a genuinely pinned account.
      let bridged = false;
      await ensureV5(account, () => {
        bridged = true;
        setPhase({ k: "preparing" });
      });
      if (bridged) setStatus(await api.status(account));
      setPhase({ k: "signing" });
      let hash: Hex;
      if (req.method === "personal_sign") {
        const raw = req.params[0];
        hash = isHex(String(raw)) ? hashMessage({ raw: raw as Hex }) : hashMessage(String(raw));
      } else {
        // eth_signTypedData_v4
        const td = typeof req.params[1] === "string" ? JSON.parse(req.params[1] as string) : req.params[1];
        hash = hashTypedData(td);
      }
      const assertion = await assertWithPasskey(credId, hash);
      const { signature } = await api.sign1271(account, hash, assertion);
      finishOk(signature, "Signed");
    } catch (e) {
      if (isUserCancel(e)) {
        setPhase({ k: "review" }); // let them try again; closing rejects
      } else {
        setPhase({ k: "error", message: humanError(e).text });
      }
    }
  }, [req, account, finishOk]);

  // ---- render ----

  if (phase.k === "onboarding") {
    return (
      <div className="connect">
        <ConnectHead origin={req?.origin} />
        <p className="connect-lead">Create your Suho account to continue. It's free, and your passkey never leaves this device.</p>
        <Onboard paused={status?.sponsoredOnboardingPaused ?? false} onRecover={() => {}} onLegacy={() => {}} onDone={onOnboarded} />
      </div>
    );
  }

  return (
    <div className="connect">
      <ConnectHead origin={req?.origin} />
      {phase.k === "waiting" && (
        <div className="connect-body center">
          <Spinner /> <span className="muted">Waiting for the request…</span>
        </div>
      )}

      {phase.k === "error" && (
        <div className="connect-body">
          <div className="errbox">{phase.message}</div>
          <button className="secondary" onClick={() => reject(phase.message, 4001)}>Close</button>
        </div>
      )}

      {phase.k === "done" && (
        <div className="connect-body center">
          <div className="connect-done"><Seal small /> {phase.label}</div>
          <p className="muted">You can return to the site.</p>
        </div>
      )}

      {(phase.k === "review" || phase.k === "signing" || phase.k === "preparing") && req && (
        <RequestView
          req={req}
          status={status}
          account={account}
          busy={phase.k === "signing" || phase.k === "preparing"}
          busyLabel={phase.k === "preparing" ? "Preparing your account… first time only" : "Confirm on your device…"}
          onConnect={approveConnect}
          onSign={approveSign}
          onReject={() => reject("User rejected the request", 4001)}
        />
      )}
    </div>
  );
}

function ConnectHead({ origin }: { origin?: string }) {
  return (
    <header className="connect-top">
      <span className="wordmark">Suho<span className="hanja">수호</span></span>
      {origin && <span className="connect-origin" title={origin}>{prettyOrigin(origin)}</span>}
    </header>
  );
}

function prettyOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function RequestView({
  req,
  status,
  account,
  busy,
  busyLabel,
  onConnect,
  onSign,
  onReject,
}: {
  req: BoundRequest;
  status: Status | null;
  account: `0x${string}` | null;
  busy: boolean;
  busyLabel: string;
  onConnect: () => void;
  onSign: () => void;
  onReject: () => void;
}) {
  const host = prettyOrigin(req.origin);
  const name = status?.upId ? `${status.upId}.up.id` : account ? shortAddr(account) : "";
  const signMethod = req.method === "personal_sign" || req.method === "eth_signTypedData_v4";

  return (
    <div className="connect-body">
      <div className="connect-acct">
        {status?.isVerified ? <Seal small /> : <span className="gray-dot" aria-hidden="true" />}
        <div className="connect-acct-text">
          <span className="connect-acct-name">{name}</span>
          {account && <span className="connect-acct-addr">{shortAddr(account)}</span>}
        </div>
      </div>

      {req.method === "eth_requestAccounts" && (
        <>
          <p className="connect-ask"><b>{host}</b> wants to see your address and name.</p>
          <p className="connect-note">It cannot move funds or sign anything without a separate approval.</p>
          <div className="connect-actions">
            <button className="secondary" onClick={onReject} disabled={busy}>Cancel</button>
            <button className="primary" onClick={onConnect} disabled={busy}>Connect</button>
          </div>
        </>
      )}

      {signMethod && req.method === "personal_sign" && (
        <SignMessageView host={host} decoded={decodePersonalSign(req.params[0])} busy={busy} busyLabel={busyLabel} onSign={onSign} onReject={onReject} />
      )}

      {signMethod && req.method === "eth_signTypedData_v4" && (
        <SignTypedView host={host} data={typedRows(req.params)} busy={busy} busyLabel={busyLabel} onSign={onSign} onReject={onReject} />
      )}
    </div>
  );
}

function SignMessageView({ host, decoded, busy, busyLabel, onSign, onReject }: { host: string; decoded: DecodedMessage; busy: boolean; busyLabel: string; onSign: () => void; onReject: () => void }) {
  return (
    <>
      <p className="connect-ask"><b>{host}</b> asks you to sign this message.</p>
      <p className="connect-note">Signing proves you control this account. It does not move funds.</p>
      {decoded.siwe && (
        <div className="connect-siwe">
          <div className="statrow"><span className="k">Domain</span><span className="v">{decoded.siwe.domain}</span></div>
          {decoded.siwe.nonce && <div className="statrow"><span className="k">Nonce</span><span className="v mono">{decoded.siwe.nonce}</span></div>}
          {decoded.siwe.expiry && <div className="statrow"><span className="k">Expires</span><span className="v mono">{decoded.siwe.expiry}</span></div>}
        </div>
      )}
      <pre className="connect-msg">{decoded.text}</pre>
      <div className="connect-actions">
        <button className="secondary" onClick={onReject} disabled={busy}>Cancel</button>
        <button className="primary" onClick={onSign} disabled={busy}>{busy ? busyLabel : "Sign"}</button>
      </div>
    </>
  );
}

function SignTypedView({ host, data, busy, busyLabel, onSign, onReject }: { host: string; data: ReturnType<typeof typedRows>; busy: boolean; busyLabel: string; onSign: () => void; onReject: () => void }) {
  return (
    <>
      <p className="connect-ask"><b>{host}</b> asks you to sign structured data.</p>
      <p className="connect-note">Signing proves you control this account. It does not move funds.</p>
      {data ? (
        <div className="connect-typed">
          <div className="statrow"><span className="k">Type</span><span className="v">{data.primaryType}</span></div>
          {data.domain.name != null && <div className="statrow"><span className="k">Domain</span><span className="v">{String(data.domain.name)}</span></div>}
          {data.rows.map(([k, v]) => (
            <div className="statrow" key={k}><span className="k">{k}</span><span className="v mono connect-typed-val">{v}</span></div>
          ))}
        </div>
      ) : (
        <div className="errbox">Suho couldn't read this typed data.</div>
      )}
      <div className="connect-actions">
        <button className="secondary" onClick={onReject} disabled={busy}>Cancel</button>
        <button className="primary" onClick={onSign} disabled={busy || !data}>{busy ? busyLabel : "Sign"}</button>
      </div>
    </>
  );
}
