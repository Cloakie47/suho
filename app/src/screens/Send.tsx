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
import { api, type Status } from "../api";
import { accountNonce, computeChallenge, watchReceipt, type Call } from "../chain";
import { capForAccount } from "../execute";
import { assertWithPasskey } from "../webauthn";
import { activeAccount, isLegacyDemo, storedCredential, LARGE_SEND_THRESHOLD_WEI } from "../config";
import { Checklist, LS_FIRST_SEND } from "./Checklist";
import { Seal, Spinner, fmtEth, shortAddr } from "../ui";
import { useToast, type TxToast } from "../toast";
import { fetchActivity, type ActivityItem } from "../activity";
import { humanError, isUserCancel } from "../errors";
import { recordSend, sessionStats, measuredMs } from "../stats";

interface Recipient {
  address: Hex;
  display: string;
  verified: boolean;
  verifiedBy: string | null;
  notFound?: boolean;
}

// The lifecycle toast is the transaction surface; inline phases cover only the
// passkey prompt, the hold-to-confirm modal, and pre-relay errors.
type SendPhase =
  | { k: "idle" }
  | { k: "signing" }
  | { k: "inflight" }
  | { k: "confirm" } // hold-to-confirm interstitial for a large unverified transfer
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
        <div className="stat-value jade">{avgMs === null ? "–" : `${(avgMs / 1000).toFixed(1)}s`}</div>
        <div className="stat-sub">flashblocks, measured live</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          Verified recipients <Users {...icon} />
        </div>
        <div className="stat-value">{verifiedNames === null ? "–" : verifiedNames.toLocaleString()}</div>
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
      {failed && <div className="muted" style={{ padding: "8px 0 16px" }}>Explorer unreachable. Activity hidden.</div>}
      {!items && !failed && (
        <div style={{ padding: "8px 0 16px", display: "grid", gap: 14 }}>
          {[80, 60, 70].map((w, i) => (
            <div key={i} className="skeleton" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}
      {items && items.length === 0 && (
        <div className="muted" style={{ padding: "8px 0 16px" }}>
          No sends yet. Try <b>suho.up.id</b>.
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

/** Hold-to-confirm interstitial for the one risky send: a large transfer to an
 *  unverified address. There is NO one-time code — honestly, the only approval is
 *  your passkey. This modal adds deliberate friction (press and hold) so the send
 *  can't happen on a stray tap, then one passkey prompt completes it. */
const HOLD_MS = 1200;

function ConfirmModal({
  recipient,
  amount,
  onConfirm,
  onClose,
  busy,
}: {
  recipient: string;
  amount: string;
  onConfirm: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [progress, setProgress] = useState(0); // 0..1 hold completion
  const raf = useRef<number>();
  const start = useRef<number>(0);
  const done = useRef(false);

  const stopHold = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = undefined;
    if (!done.current) setProgress(0);
  };
  const tick = () => {
    const p = Math.min(1, (performance.now() - start.current) / HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      done.current = true;
      onConfirm();
      return;
    }
    raf.current = requestAnimationFrame(tick);
  };
  const beginHold = () => {
    if (busy || done.current) return;
    start.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };

  const held = busy || done.current;

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Confirm large transfer">
      <div className="l2 confirm-modal">
        <div className="confirm-head">
          <span className="confirm-shield" aria-hidden="true">
            <TriangleAlert size={26} color="var(--warn)" strokeWidth={1.75} />
          </span>
          <div>
            <h2 style={{ margin: 0 }}>Confirm this transfer</h2>
            <div className="muted">Large transfer to an unverified address.</div>
          </div>
        </div>
        <p className="muted" style={{ margin: "12px 0 0" }}>
          You're sending <b>{amount} ETH</b> to <b className="mono">{recipient}</b>, an address Suho
          can't identify. There's no verification code — your passkey is the only approval. Hold the
          button to confirm you meant this, then approve with your passkey.
        </p>
        <button
          className="primary wide hold-confirm"
          disabled={busy}
          onPointerDown={beginHold}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          style={{ marginTop: 18, ["--hold" as string]: progress }}
          aria-label="Press and hold to confirm"
        >
          <span className="hold-fill" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
          <span className="hold-label">
            {busy ? "Sending…" : held ? "Confirming…" : progress > 0 ? "Keep holding…" : "Hold to confirm"}
          </span>
        </button>
        <button className="secondary" onClick={onClose} disabled={busy}>
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

  const doSend = async () => {
    if (!recipient || recipient.notFound) return;
    const credentialId = storedCredential();
    if (!credentialId) {
      setPhase({ k: "error", message: "No passkey linked on this device. Visit Upgrade first." });
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
    // Guarded send: a large transfer to an unverified address shows a
    // hold-to-confirm interstitial first (deliberate friction, not a passkey
    // prompt). On confirm, ONE passkey signature completes it. There is no
    // one-time code — the passkey, bound to this exact recipient+amount, is the
    // only approval.
    const needsConfirm = !recipient.verified && value >= LARGE_SEND_THRESHOLD_WEI;
    if (needsConfirm && phase.k !== "confirm") {
      setPhase({ k: "confirm" });
      return;
    }
    const fromConfirm = phase.k === "confirm";
    let handle: TxToast | null = null;
    try {
      setPhase({ k: "signing" });
      const calls: Call[] = [{ target: recipient.address, value, data: "0x" }];
      const [nonce, maxGasPayment] = await Promise.all([
        accountNonce(activeAccount()),
        capForAccount(activeAccount()),
      ]);
      const challenge = computeChallenge(activeAccount(), nonce, calls, maxGasPayment);
      const webauthn = await assertWithPasskey(credentialId, challenge); // the one prompt
      setPhase({ k: "inflight" });
      handle = toast.begin(`Sending ${amount} ETH to ${recipient.display}…`);
      const h = handle;
      const t0 = performance.now();
      const { txHash } = await api.relay(
        activeAccount(),
        calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })),
        "", // no OTP: the guard allows a confirmed large unverified send on passkey authority
        webauthn,
        maxGasPayment?.toString(),
      );
      const timing = await watchReceipt(txHash, t0, {
        preconf: (ms) => h.preconfirmed("Sent", ms),
        final: () => h.final(txHash),
        reverted: () => h.error(new Error("TransactionReverted")),
      });
      recordSend(txHash, timing.preconfMs); // session stat cards + feed ms
      localStorage.setItem(LS_FIRST_SEND, "1"); // O5 checklist step 4
      setPhase({ k: "idle" });
      setActBump((b) => b + 1);
      refresh();
    } catch (e) {
      if (isUserCancel(e)) {
        // Passkey prompt canceled. Not an error: back to the confirm interstitial
        // (if that's where we came from) or idle.
        handle?.dismiss();
        setPhase(fromConfirm ? { k: "confirm" } : { k: "idle" });
        toast.note("Canceled.");
      } else if (handle) {
        handle.error(e); // typed revert -> human sentence in the toast
        setPhase({ k: "idle" });
      } else {
        // pre-relay failure with no toast yet: carry it through one
        (toast.begin(`Sending ${amount} ETH to ${recipient.display}…`)).error(e);
        setPhase({ k: "idle" });
      }
    }
  };

  const value = (() => {
    try { return parseEther(amount || "0"); } catch { return 0n; }
  })();
  const willWarn = recipient && !recipient.notFound && !recipient.verified;
  const willConfirm = willWarn && value >= LARGE_SEND_THRESHOLD_WEI;
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
            placeholder="Recipient: name or 0x address"
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
            onClick={() => doSend()}
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
                <div className="warnbox">Unverified address. Suho can’t identify who this is.</div>
              )}
            </div>
          </div>
        )}
        {willConfirm && (
          <div className="warnbox">
            Large transfer to an unverified address — you'll hold to confirm, then approve with
            your passkey. That signature is the only approval; there's no verification code.
          </div>
        )}
        {phase.k === "signing" && (
          <div className="status-line">
            <Spinner /> Confirm with your passkey…
          </div>
        )}
        {phase.k === "error" && <div className="errbox">{phase.message}</div>}
      </div>

      {/* O5: guided setup for onboarded accounts (legacy demo skips it) */}
      {!isLegacyDemo() && <Checklist status={status} refresh={refresh} />}

      {/* R2 row 2: session stat cards */}
      <StatCards verifiedNames={verifiedNames} />

      {/* R2 row 3: real activity feed */}
      <ActivityFeed bump={actBump} />

      {phase.k === "confirm" && recipient && (
        <ConfirmModal
          recipient={recipient.display}
          amount={amount}
          onConfirm={() => doSend()}
          onClose={() => setPhase({ k: "idle" })}
          busy={busy}
        />
      )}
    </div>
  );
}
