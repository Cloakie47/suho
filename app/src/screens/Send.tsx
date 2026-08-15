import { useEffect, useRef, useState } from "react";
import { isAddress, parseEther, type Hex } from "viem";
import { ExternalLink, TriangleAlert } from "lucide-react";
import { api, type Status } from "../api";
import { accountNonce, computeChallenge, watchReceipt, type Call } from "../chain";
import { capForAccount, assertAffordable, InsufficientFundsError } from "../execute";
import { assertWithPasskey } from "../webauthn";
import { requireActiveAccount, isLegacyDemo, storedCredential, LARGE_SEND_THRESHOLD_WEI } from "../config";
import { Checklist, LS_FIRST_SEND } from "./Checklist";
import { Seal, Spinner, fmtEth, shortAddr } from "../ui";
import { useToast, type TxToast } from "../toast";
import { fetchActivity, type ActivityItem } from "../activity";
import { humanError, isUserCancel } from "../errors";
import { recordSend } from "../stats";
import { memoCall, sanitizeBody, MEMO_MAX } from "../messages";

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

/** A slim "recent sends" strip on the Send screen — the full history, notes, and
 *  requests live on the Activity screen now. Read-only, last few send rows. */
function RecentSends({ bump }: { bump: number }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      // Post-send: poll briefly until the new tx is indexed, then show it.
      const isPostSend = bump > 0;
      const tries = isPostSend ? 6 : 1;
      for (let i = 0; i < tries; i++) {
        try {
          const v = await fetchActivity(i === 0 && isPostSend);
          if (!alive) return;
          const sends = v.filter((it) => it.kind === "send" || it.kind === "transfer");
          setItems(sends.slice(0, 3));
          if (!isPostSend || sends.length > 0) return;
        } catch {
          if (!alive) return;
          setItems([]);
        }
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      alive = false;
    };
  }, [bump]);

  if (!items || items.length === 0) return null;
  return (
    <div className="card activity">
      <div className="activity-head">
        <h2>Recent sends</h2>
        <span className="msg-empty">Full history in Activity</span>
      </div>
      {items.map((it) => (
        <div key={it.hash}>
          <div className="act-row">
            {it.verified ? <Seal small /> : <span className="act-icon amber"><TriangleAlert size={16} strokeWidth={1.5} /></span>}
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
              {it.amountWei !== undefined && <div className="act-amt">{fmtEth(it.amountWei, 4)} ETH</div>}
            </div>
            <a className="act-link" href={it.explorer} target="_blank" rel="noreferrer" aria-label="View on explorer">
              <ExternalLink size={14} strokeWidth={1.5} />
            </a>
          </div>
          {it.memo && <div className="act-memo">"{it.memo}"</div>}
        </div>
      ))}
    </div>
  );
}

/** Hold-to-confirm interstitial for the one risky send: a large transfer to an
 *  unverified address. There is NO one-time code — honestly, the only approval is
 *  your passkey. This modal adds deliberate friction (press and hold) so the send
 *  can't happen on a stray tap, then one passkey prompt completes it. */
const HOLD_MS = 1200;

function ConfirmModal({
  amount,
  onConfirm,
  onClose,
  busy,
}: {
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
          Sending <b>{amount} ETH</b> to an unverified address. Hold to confirm.
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
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<SendPhase>({ k: "idle" });
  const [actBump, setActBump] = useState(0);
  const debounceRef = useRef<number>();
  const toast = useToast();

  // Directory deep-link (D2): arriving with a prefilled recipient starts resolution.
  useEffect(() => {
    if (prefillRecipient) setInput(prefillRecipient);
  }, [prefillRecipient]);

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
    // Build the batch up front: the transfer, plus (optionally) an on-chain memo
    // in the SAME execute() — one passkey tap, one atomic tx (Phase M).
    const memo = memoCall(recipient.address, note);
    const calls: Call[] = [{ target: recipient.address, value, data: "0x" }];
    if (memo) calls.push(memo);

    // Affordability preflight (value + gas reimbursement cap) with a clear
    // message BEFORE the hold-to-confirm or passkey prompt.
    try {
      const cap = await capForAccount(requireActiveAccount());
      await assertAffordable(requireActiveAccount(), calls, cap);
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        setPhase({ k: "error", message: e.human });
        return;
      }
      // A balance/cap read failure (network) shouldn't block; the relay path
      // surfaces a mapped error if it truly can't proceed.
    }
    // Guarded send: a large transfer to an unverified address shows a
    // hold-to-confirm interstitial first (deliberate friction, not a passkey
    // prompt). On confirm, ONE passkey signature completes it.
    const needsConfirm = !recipient.verified && value >= LARGE_SEND_THRESHOLD_WEI;
    if (needsConfirm && phase.k !== "confirm") {
      setPhase({ k: "confirm" });
      return;
    }
    const fromConfirm = phase.k === "confirm";
    let handle: TxToast | null = null;
    try {
      setPhase({ k: "signing" });
      const [nonce, maxGasPayment] = await Promise.all([
        accountNonce(requireActiveAccount()),
        capForAccount(requireActiveAccount()),
      ]);
      const challenge = computeChallenge(requireActiveAccount(), nonce, calls, maxGasPayment);
      const webauthn = await assertWithPasskey(credentialId, challenge); // the one prompt
      setPhase({ k: "inflight" });
      handle = toast.begin(`Sending ${amount} ETH to ${recipient.display}…`);
      const h = handle;
      const t0 = performance.now();
      const { txHash } = await api.relay(
        requireActiveAccount(),
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
      recordSend(txHash, timing.preconfMs);
      localStorage.setItem(LS_FIRST_SEND, "1"); // O5 checklist step 4
      setNote("");
      setPhase({ k: "idle" });
      setActBump((b) => b + 1);
      refresh();
    } catch (e) {
      if (isUserCancel(e)) {
        handle?.dismiss();
        setPhase(fromConfirm ? { k: "confirm" } : { k: "idle" });
        toast.note("Canceled.");
      } else if (handle) {
        handle.error(e); // typed revert -> human sentence in the toast
        setPhase({ k: "idle" });
      } else {
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

      {/* composer hero card */}
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

        {/* M2: optional PUBLIC on-chain note, batched into the same tx. */}
        <div className="memo-field">
          <input
            type="text"
            className="memo-input"
            placeholder="Add a public note (visible on-chain)"
            value={note}
            maxLength={MEMO_MAX}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Public note"
          />
          {note.length > 0 && <span className="memo-count">{sanitizeBody(note).length}/{MEMO_MAX}</span>}
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
          <div className="warnbox">Large transfer to an unverified address. You'll hold to confirm.</div>
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

      {/* slim recent sends; full history lives on the Activity screen */}
      <RecentSends bump={actBump} />

      {phase.k === "confirm" && recipient && (
        <ConfirmModal
          amount={amount}
          onConfirm={() => doSend()}
          onClose={() => setPhase({ k: "idle" })}
          busy={busy}
        />
      )}
    </div>
  );
}
