import { useEffect, useRef, useState } from "react";
import { isAddress, parseEther, type Hex } from "viem";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ExternalLink,
  IdCard,
  KeyRound,
  ShieldCheck,
  Timer,
  TriangleAlert,
  Users,
  Zap,
} from "lucide-react";
import { api, GuardianError, type Status } from "../api";
import { accountNonce, computeChallenge, watchReceipt, type Call } from "../chain";
import { assertWithPasskey } from "../webauthn";
import { DEMO_ACCOUNT, LS_CREDENTIAL, OTP_THRESHOLD_WEI } from "../config";
import { Seal, Spinner, fmtEth, shortAddr } from "../ui";
import { useToast, type TxToast } from "../toast";
import { fetchActivity, type ActivityItem } from "../activity";
import { recordSend, sessionStats, measuredMs } from "../stats";

interface Recipient {
  address: Hex;
  display: string;
  verified: boolean;
  verifiedBy: string | null;
  notFound?: boolean;
}

// The lifecycle toast is the transaction surface; inline phases cover only the
// passkey prompt, the OTP modal, and pre-relay errors.
type SendPhase =
  | { k: "idle" }
  | { k: "signing" }
  | { k: "inflight" }
  | { k: "otp"; expiresAt: number }
  | { k: "error"; message: string };

const icon = { size: 14, strokeWidth: 1.5 } as const;

function StatCards({ verifiedNames }: { verifiedNames: number | null }) {
  const { sends, avgMs } = sessionStats();
  return (
    <div className="stat-grid">
      <div className="stat-card">
        <div className="stat-label">
          Sends this session <Zap {...icon} />
        </div>
        <div className="stat-value">{sends}</div>
        <div className="stat-sub">passkey-signed</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          Avg preconfirmation <Timer {...icon} />
        </div>
        <div className="stat-value jade">{avgMs === null ? "—" : `${(avgMs / 1000).toFixed(1)}s`}</div>
        <div className="stat-sub">flashblocks, measured live</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          Verified recipients <Users {...icon} />
        </div>
        <div className="stat-value">{verifiedNames === null ? "—" : verifiedNames.toLocaleString()}</div>
        <div className="stat-sub">active up.id names</div>
      </div>
    </div>
  );
}

function ActivityIcon({ item }: { item: ActivityItem }) {
  if (item.kind === "send" && item.verified) return <Seal small />;
  const cls =
    item.kind === "send" || item.kind === "transfer"
      ? "act-icon amber"
      : item.kind === "received"
        ? "act-icon jade"
        : "act-icon seal-c";
  const I =
    item.kind === "arise"
      ? KeyRound
      : item.kind === "card"
        ? IdCard
        : item.kind === "upgrade"
          ? ShieldCheck
          : item.kind === "received"
            ? ArrowDownLeft
            : item.kind === "transfer"
              ? ArrowUpRight
              : TriangleAlert;
  return (
    <span className={cls}>
      <I size={16} strokeWidth={1.5} />
    </span>
  );
}

function ActivityFeed({ bump }: { bump: number }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchActivity().then(
      (v) => alive && setItems(v),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [bump]);

  return (
    <div className="card activity">
      <h2>Activity</h2>
      {failed && <div className="muted" style={{ padding: "8px 0 16px" }}>Explorer unreachable — activity hidden.</div>}
      {!items && !failed && (
        <div style={{ padding: "8px 0 16px", display: "grid", gap: 14 }}>
          {[80, 60, 70].map((w, i) => (
            <div key={i} className="skeleton" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}
      {items && items.length === 0 && (
        <div className="muted" style={{ padding: "8px 0 16px" }}>
          No sends yet — try <b>suho.up.id</b>.
        </div>
      )}
      {items &&
        items.map((it) => {
          const ms = measuredMs(it.hash);
          return (
            <div className="act-row" key={it.hash}>
              <ActivityIcon item={it} />
              <div className="act-main">
                <div className="act-title">{it.title}</div>
                <div className="act-sub">
                  {it.counterparty ? `${shortAddr(it.counterparty)} · ` : ""}
                  {new Date(it.timestamp).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </div>
              <div className="act-right">
                {it.amountWei !== undefined && (
                  <div className="act-amt">{fmtEth(it.amountWei, 4)} ETH</div>
                )}
                {ms !== undefined && <div className="act-ms">{(ms / 1000).toFixed(1)}s</div>}
              </div>
              <a className="act-link" href={it.explorer} target="_blank" rel="noreferrer" aria-label="View on explorer">
                <ExternalLink size={14} strokeWidth={1.5} />
              </a>
            </div>
          );
        })}
    </div>
  );
}

/** R5: OTP interstitial as an L2 modal — 6 code boxes, countdown ring. */
function OtpModal({
  expiresAt,
  value,
  onChange,
  onSubmit,
  onClose,
  busy,
}: {
  expiresAt: number;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [countdown, setCountdown] = useState(() =>
    Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
  );
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    const t = window.setInterval(
      () => setCountdown(Math.max(0, expiresAt - Math.floor(Date.now() / 1000))),
      500,
    );
    return () => window.clearInterval(t);
  }, [expiresAt]);

  useEffect(() => {
    boxes.current[Math.min(value.length, 5)]?.focus();
  }, [value.length]);

  const CIRC = 2 * Math.PI * 18;
  const frac = Math.min(1, countdown / 600);

  const setDigit = (i: number, d: string) => {
    const chars = value.split("");
    chars[i] = d;
    onChange(chars.join("").replace(/\D/g, "").slice(0, 6));
  };

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Verification required">
      <div className="l2 otp-modal">
        <div className="otp-head">
          <div className="otp-ring" aria-hidden="true">
            <svg width="44" height="44" viewBox="0 0 44 44">
              <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(243,239,231,0.1)" strokeWidth="3" />
              <circle
                cx="22" cy="22" r="18" fill="none"
                stroke={countdown > 60 ? "var(--jade)" : "var(--seal)"}
                strokeWidth="3" strokeLinecap="round"
                strokeDasharray={CIRC}
                strokeDashoffset={CIRC * (1 - frac)}
              />
            </svg>
            <span className="t">
              {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
            </span>
          </div>
          <div>
            <h2 style={{ margin: 0 }}>Verification required</h2>
            <div className="muted">Large transfer to an unverified address.</div>
          </div>
        </div>
        <p className="muted" style={{ margin: "6px 0 0" }}>
          Enter the code from the verification service.
        </p>
        <div className="code-boxes">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <input
              key={i}
              ref={(el) => (boxes.current[i] = el)}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={value[i] ?? ""}
              aria-label={`Code digit ${i + 1}`}
              onChange={(e) => setDigit(i, e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !value[i]) {
                  onChange(value.slice(0, Math.max(0, i - 1)));
                }
              }}
            />
          ))}
        </div>
        <div className="countdown">
          {countdown > 0 ? "single-use · bound to this exact transfer" : "code expired — close and send again"}
        </div>
        <button
          className="primary wide"
          disabled={value.length !== 6 || countdown === 0 || busy}
          onClick={onSubmit}
        >
          Verify & send
        </button>
        <button className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function Send({
  status,
  refresh,
  prefillRecipient,
}: {
  status: Status;
  refresh: () => void;
  prefillRecipient?: string | null;
}) {
  const [input, setInput] = useState("");
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [resolving, setResolving] = useState(false);
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<SendPhase>({ k: "idle" });
  const [otpValue, setOtpValue] = useState("");
  const [verifiedNames, setVerifiedNames] = useState<number | null>(null);
  const [actBump, setActBump] = useState(0);
  const debounceRef = useRef<number>();
  const toast = useToast();

  // Directory deep-link (D2): arriving with a prefilled recipient starts resolution.
  useEffect(() => {
    if (prefillRecipient) setInput(prefillRecipient);
  }, [prefillRecipient]);

  // stat card: verified-name count from the directory cache
  useEffect(() => {
    api.directory("").then(
      (r) => setVerifiedNames(r.total),
      () => setVerifiedNames(null),
    );
  }, []);

  // Live up.id resolution, 300ms debounce.
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    setRecipient(null);
    const q = input.trim();
    if (!q) return;
    debounceRef.current = window.setTimeout(async () => {
      setResolving(true);
      try {
        if (isAddress(q)) {
          const s = await api.status(q);
          setRecipient({
            address: q as Hex,
            display: s.upId ? `${s.upId}.up.id` : shortAddr(q),
            verified: s.isVerified,
            verifiedBy: s.verifiedBy,
          });
        } else {
          const r = await api.resolve(q);
          if (!r.address) {
            setRecipient({
              address: "0x0" as Hex, display: q, verified: false, verifiedBy: null, notFound: true,
            });
          } else {
            setRecipient({
              address: r.address,
              display: q.endsWith(".up.id") ? q : `${q}.up.id`,
              verified: r.verified,
              verifiedBy: r.verifiedBy,
            });
          }
        }
      } finally {
        setResolving(false);
      }
    }, 300);
  }, [input]);

  const doSend = async (otpCode: string) => {
    if (!recipient || recipient.notFound) return;
    const credentialId = localStorage.getItem(LS_CREDENTIAL);
    if (!credentialId) {
      setPhase({ k: "error", message: "No passkey linked on this device — visit Upgrade first." });
      return;
    }
    let value: bigint;
    try {
      value = parseEther(amount);
    } catch {
      setPhase({ k: "error", message: "Invalid amount." });
      return;
    }
    if (value > BigInt(status.balance)) {
      setPhase({ k: "error", message: "Insufficient balance." });
      return;
    }
    const fromOtp = phase.k === "otp" ? phase : null;
    let handle: TxToast | null = null;
    try {
      setPhase({ k: "signing" });
      const calls: Call[] = [{ target: recipient.address, value, data: "0x" }];
      const nonce = await accountNonce(DEMO_ACCOUNT);
      const challenge = computeChallenge(DEMO_ACCOUNT, nonce, calls);
      const webauthn = await assertWithPasskey(credentialId, challenge);
      setPhase({ k: "inflight" });
      // One toast per transaction; the verb matches the button that launched it.
      handle = toast.begin(`Sending ${amount} ETH to ${recipient.display}…`);
      const h = handle;
      const t0 = performance.now();
      const { txHash } = await api.relay(
        DEMO_ACCOUNT,
        calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })),
        otpCode,
        webauthn,
      );
      const timing = await watchReceipt(txHash, t0, {
        preconf: (ms) => h.preconfirmed("Sent", ms),
        final: () => h.final(txHash),
        reverted: () => h.error(new Error("TransactionReverted")),
      });
      recordSend(txHash, timing.preconfMs); // session stat cards + feed ms
      setOtpValue("");
      setPhase({ k: "idle" });
      setActBump((b) => b + 1);
      refresh();
    } catch (e) {
      if (e instanceof GuardianError && e.message === "OtpRequired") {
        handle?.dismiss(); // no toast — the interstitial IS the response (skill)
        try {
          const r = await api.otpRequest(DEMO_ACCOUNT, recipient.address, value.toString());
          setOtpValue("");
          setPhase({ k: "otp", expiresAt: r.expiresAt });
        } catch (e2) {
          setPhase({ k: "error", message: String(e2) });
        }
      } else if (handle) {
        handle.error(e); // typed revert -> human sentence in the toast
        setPhase(fromOtp ?? { k: "idle" }); // bad code: reopen the interstitial
      } else {
        // pre-relay failures (e.g. passkey prompt cancelled) stay inline
        setPhase({ k: "error", message: String(e) });
      }
    }
  };

  const value = (() => {
    try { return parseEther(amount || "0"); } catch { return 0n; }
  })();
  const willWarn = recipient && !recipient.notFound && !recipient.verified;
  const willOtp = willWarn && value >= OTP_THRESHOLD_WEI;
  const busy = phase.k === "signing" || phase.k === "inflight";

  return (
    <div>
      <div className="screen-head">
        <p className="eyebrow">GUARDED TRANSFER</p>
        <h1 className="screen-title">Send</h1>
      </div>

      {/* R2 row 1: composer hero card */}
      <div className="card hero-card">
        <div className="composer-row">
          <input
            type="text"
            placeholder="Recipient — name or 0x address"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Recipient"
          />
          <input
            type="text"
            placeholder="Amount (ETH)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount in ETH"
          />
          <button
            className="primary"
            disabled={!recipient || recipient.notFound || !amount || busy}
            onClick={() => doSend("")}
          >
            Send
          </button>
        </div>

        {resolving && (
          <div className="status-line">
            <Spinner /> resolving…
          </div>
        )}
        {recipient && recipient.notFound && (
          <div className="warnbox">No active up.id named “{recipient.display}”.</div>
        )}
        {recipient && !recipient.notFound && (
          <div className={`recipient-card ${recipient.verified ? "verified" : "unverified"}`}>
            {recipient.verified ? <Seal large /> : <TriangleAlert size={22} color="var(--warn)" strokeWidth={1.5} />}
            <div>
              <div className="name">{recipient.display}</div>
              <div className="mono muted">{recipient.address}</div>
              {recipient.verified ? (
                <div>
                  <div className="verified-label">Verified human</div>
                  <div className="attestation-note" title={`Attester: ${recipient.verifiedBy}`}>
                    Dojang attestation · testnet issuer
                  </div>
                </div>
              ) : (
                <div className="warnbox">Unverified address — Suho can’t identify who this is.</div>
              )}
            </div>
          </div>
        )}
        {willOtp && (
          <div className="warnbox">
            Large transfer to an unverified address — a verification code will be required.
          </div>
        )}
        {phase.k === "signing" && (
          <div className="status-line">
            <Spinner /> Confirm with your passkey…
          </div>
        )}
        {phase.k === "error" && <div className="errbox">{phase.message}</div>}
      </div>

      {/* R2 row 2: session stat cards */}
      <StatCards verifiedNames={verifiedNames} />

      {/* R2 row 3: real activity feed */}
      <ActivityFeed bump={actBump} />

      {phase.k === "otp" && (
        <OtpModal
          expiresAt={phase.expiresAt}
          value={otpValue}
          onChange={setOtpValue}
          onSubmit={() => doSend(otpValue)}
          onClose={() => setPhase({ k: "idle" })}
          busy={busy}
        />
      )}
    </div>
  );
}
