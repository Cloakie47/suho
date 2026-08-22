import { useEffect, useRef, useState } from "react";
import { isAddress, parseEther, type Hex } from "viem";
import { ExternalLink, TriangleAlert } from "lucide-react";
import { api, type Status } from "../api";
import { accountNonce, computeChallenge, watchReceipt, readSpending, type Call } from "../chain";
import { capForAccount, assertAffordable, InsufficientFundsError } from "../execute";
import { assertWithPasskey } from "../webauthn";
import { requireActiveAccount, isLegacyDemo, storedCredential } from "../config";
import { Checklist, LS_FIRST_SEND } from "./Checklist";
import { Seal, Spinner, fmtEth, shortAddr, ResetsIn } from "../ui";
import { useToast, type TxToast } from "../toast";
import { fetchActivity, peekActivity, type ActivityItem } from "../activity";
import { humanError, isUserCancel } from "../errors";
import { recordSend, sessionStats } from "../stats";
import { memoCall, sanitizeBody, MEMO_MAX } from "../messages";
import { requestSpendCode, isOverLimit, UNLIMITED } from "../spending";
import { convergenceCalls, needsConvergence } from "../converge";

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
  | { k: "sendcode"; code: string; sending: boolean; error?: string } // V4 email factor
  | { k: "error"; message: string };

/** A slim "recent sends" strip on the Send screen — the full history, notes, and
 *  requests live on the Activity screen now. Read-only, last few send rows.
 *  Never blocks the composer: it paints instantly from cache if present, then
 *  refreshes in the background WITHOUT the memo getLogs (Send stays light). */
const sendRows = (v: ActivityItem[]) =>
  v.filter((it) => it.kind === "send" || it.kind === "transfer").slice(0, 3);

function RecentSends({ account, bump }: { account: string; bump: number }) {
  const [items, setItems] = useState<ActivityItem[] | null>(() => {
    const cached = peekActivity(account);
    return cached ? sendRows(cached) : null;
  });
  useEffect(() => {
    let alive = true;
    (async () => {
      // Post-send: poll briefly until the new tx is indexed, then show it.
      const isPostSend = bump > 0;
      const tries = isPostSend ? 6 : 1;
      for (let i = 0; i < tries; i++) {
        try {
          // withMemos:false — no log queries on the Send screen.
          const v = await fetchActivity(i === 0 && isPostSend, { withMemos: false });
          if (!alive) return;
          const sends = sendRows(v);
          setItems(sends);
          if (!isPostSend || sends.length > 0) return;
        } catch {
          if (!alive) return;
          setItems((prev) => prev ?? []);
        }
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      alive = false;
    };
  }, [account, bump]);

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

/** Hold-to-confirm interstitial for a send OVER the owner's limit. Deliberate
 *  friction (press and hold) so it can't happen on a stray tap; on confirm we
 *  email a code and collect it, then one passkey prompt completes the send. */
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
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Confirm a send over your limit">
      <div className="l2 confirm-modal">
        <div className="confirm-head">
          <span className="confirm-shield" aria-hidden="true">
            <TriangleAlert size={26} color="var(--warn)" strokeWidth={1.75} />
          </span>
          <div>
            <h2 style={{ margin: 0 }}>Over your limit</h2>
            <div className="muted">This send is more than your limit allows.</div>
          </div>
        </div>
        <p className="muted" style={{ margin: "12px 0 0" }}>
          Sending <b>{amount} ETH</b> is over your limit. Hold to confirm — we'll email a code to
          your recovery address, then one passkey approves the send.
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
  const [verifiedNames, setVerifiedNames] = useState<number | null>(null);
  const [spend, setSpend] = useState<{ perTx: bigint; daily: bigint; spent: bigint; remaining: bigint; windowStart: bigint } | null>(null);
  const [recoveryOn, setRecoveryOn] = useState<boolean | null>(null);
  const [converging, setConverging] = useState(false);
  // The account is behind CURRENT_TARGET and will come current on its next send.
  // Drives the pre-send copy; the actual convergence is read fresh at send time.
  const [convergePending, setConvergePending] = useState(false);
  const debounceRef = useRef<number>();
  const toast = useToast();

  // Verified-name count for the rail. One cached directory call on mount.
  useEffect(() => {
    api.directory("").then((r) => setVerifiedNames(r.total), () => setVerifiedNames(null));
  }, []);

  // The account's bank-model limits, spent-today, remaining headroom, and window
  // anchor (drives over-limit detection + the reset timer). Reloaded after each send
  // (actBump): re-read immediately, then once more after the write settles so the
  // rail reflects the new spent/remaining without a manual refresh.
  useEffect(() => {
    const account = requireActiveAccount();
    let alive = true;
    const pull = () => readSpending(account).then((s) => alive && setSpend(s), () => {});
    pull();
    api.recoveryStatus(account).then((r) => alive && setRecoveryOn(r.enabled), () => alive && setRecoveryOn(null));
    needsConvergence(account).then((n) => alive && setConvergePending(n), () => {});
    // Post-write settle read (only after a send, actBump > 0).
    const t = actBump > 0 ? window.setTimeout(pull, 1800) : undefined;
    return () => {
      alive = false;
      if (t) window.clearTimeout(t);
    };
  }, [actBump]);

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

  const doSend = async (otp = "") => {
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
    const userCalls: Call[] = [{ target: recipient.address, value, data: "0x" }];
    if (memo) userCalls.push(memo);

    // Convergence rides this send: if the account is behind CURRENT_TARGET, prepend
    // the impl/guard delta into the SAME batch so it comes current on this one tap,
    // no separate migration. Ground-truth read (self-calls the outgoing guard lets
    // through). "Preparing your account" is narrated on the signing line.
    let converge: Call[] = [];
    try {
      converge = await convergenceCalls(requireActiveAccount());
    } catch {
      // A convergence read failure must never block a send — just skip it this time.
    }
    const needsConverge = converge.length > 0;
    const calls: Call[] = [...converge, ...userCalls];

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
    // Bank model: a send over the per-transaction OR remaining-daily limit needs a
    // code from the recovery email plus a hold-to-confirm. Recipient identity does
    // not enter into it. Within limits, it's one passkey tap. A send that still
    // needs convergence runs under the OUTGOING guard (the account caches its guard
    // at execute entry), so the bank limit engages from the NEXT send, not this one.
    //
    // FUTURE EDGE (bank -> bank convergence): once an OLD guard is itself a limit
    // guard, the correct gate for a converging send is the OUTGOING guard's limits
    // (that guard checks this tx), not the incoming one's. Today every pre-bank guard
    // (the OTP / honest-transfer guards) demands nothing for a small send, so
    // skipping the gate here is exactly right; revisit this line when a lagging
    // account can already be on a limit guard.
    const over = !needsConverge && spend ? isOverLimit(value, spend.perTx, spend.remaining) : false;
    if (over && phase.k !== "confirm" && phase.k !== "sendcode") {
      if (recoveryOn !== true) {
        setPhase({ k: "error", message: "Set a recovery email to authorize larger sends. Until then this account is capped at your limit." });
        return;
      }
      setPhase({ k: "confirm" });
      return;
    }
    const fromConfirm = phase.k === "confirm" || phase.k === "sendcode";
    let handle: TxToast | null = null;
    try {
      setConverging(needsConverge);
      setPhase({ k: "signing" });
      const [nonce, maxGasPayment] = await Promise.all([
        accountNonce(requireActiveAccount()),
        capForAccount(requireActiveAccount()),
      ]);
      const challenge = computeChallenge(requireActiveAccount(), nonce, calls, maxGasPayment);
      const webauthn = await assertWithPasskey(credentialId, challenge); // the one prompt
      setPhase({ k: "inflight" });
      handle = toast.begin(
        needsConverge
          ? `Preparing your account, then sending ${amount} ETH…`
          : `Sending ${amount} ETH to ${recipient.display}…`,
      );
      const h = handle;
      const t0 = performance.now();
      const { txHash } = await api.relay(
        requireActiveAccount(),
        calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })),
        otp, // "" unless the account's large-send email lock requires a code
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
      setConverging(false);
      setPhase({ k: "idle" });
      setActBump((b) => b + 1); // re-reads spend + convergence (now current)
      refresh();
    } catch (e) {
      setConverging(false);
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
  const willConfirm =
    !!recipient && !recipient.notFound && !convergePending && !!spend && isOverLimit(value, spend.perTx, spend.remaining);
  const busy = phase.k === "signing" || phase.k === "inflight";

  // After the hold-to-confirm on an over-limit send: request the emailed code
  // (bound to this recipient + value), then collect it. The hold is friction; the
  // code is the real second factor a device thief can't read.
  const afterHoldConfirm = async () => {
    if (!recipient) return;
    setPhase({ k: "sendcode", code: "", sending: true });
    try {
      await requestSpendCode(requireActiveAccount(), recipient.address, value.toString());
      setPhase({ k: "sendcode", code: "", sending: false });
    } catch (e) {
      if (isUserCancel(e)) setPhase({ k: "idle" });
      else setPhase({ k: "sendcode", code: "", sending: false, error: humanError(e).text });
    }
  };

  return (
    <div>
      <div className="screen-head">
        <p className="eyebrow">GUARDED TRANSFER</p>
        <h1 className="screen-title">Send</h1>
      </div>

      <div className="cols">
        <div className="main">
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
                <div className="attestation-note">
                  Suho can’t say who this address belongs to. On testnet the seal is self-serve, so
                  it’s identity, not safety — your limits are what protect you.
                </div>
              )}
            </div>
          </div>
        )}
        {willConfirm && (
          <div className="warnbox">
            This is over your limit. You’ll hold to confirm and enter a code from your email.
          </div>
        )}
        {phase.k === "signing" && (
          <div className="status-line">
            <Spinner /> {converging ? "Preparing your account (first time only), then confirm with your passkey…" : "Confirm with your passkey…"}
          </div>
        )}
        {phase.k === "error" && <div className="errbox">{phase.message}</div>}
      </div>

      {/* O5: guided setup for onboarded accounts (legacy demo skips it) */}
      {!isLegacyDemo() && <Checklist status={status} refresh={refresh} />}

      {/* slim recent sends; full history lives on the Activity screen */}
      <RecentSends account={status.address} bump={actBump} />
        </div>

        {/* details rail */}
        <div className="rail">
          <div className="card">
            <h3>This account</h3>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              {status.isVerified ? <Seal small /> : <span className="gray-dot" aria-hidden="true" />}
              <div>
                <div style={{ fontWeight: 600 }}>{status.upId ? `${status.upId}.up.id` : "Suho account"}</div>
                {status.isVerified && <div className="verified-label" style={{ fontSize: "0.8rem" }}>Verified human</div>}
              </div>
            </div>
            <div className="statrow"><span className="k">Balance</span><span className="v">{fmtEth(status.balance)} ETH</span></div>
            <div className="statrow"><span className="k">Per-send limit</span><span className="v">{!spend ? "–" : spend.perTx >= UNLIMITED ? "no cap" : `${fmtEth(spend.perTx.toString())} ETH`}</span></div>
            <div className="statrow"><span className="k">Left today</span><span className="v jade">{!spend ? "–" : spend.daily >= UNLIMITED ? "no cap" : `${fmtEth(spend.remaining.toString())} ETH`}</span></div>
            {spend && spend.daily < UNLIMITED && (
              <div className="lim-reset"><ResetsIn windowStart={spend.windowStart} /></div>
            )}
          </div>

          <div className="card">
            <h3>This session</h3>
            <div className="statrow"><span className="k">Sends</span><span className="v">{sessionStats().sends}</span></div>
            <div className="statrow">
              <span className="k">Avg preconfirmation</span>
              <span className="v jade">{sessionStats().avgMs === null ? "–" : `${(sessionStats().avgMs! / 1000).toFixed(1)}s`}</span>
            </div>
            <div className="statrow"><span className="k">Names indexed</span><span className="v">{verifiedNames === null ? "–" : verifiedNames.toLocaleString()}</span></div>
          </div>

          <div className="card">
            <h3>Your limits</h3>
            <p className="explain">
              Send up to your limits with just your passkey. A send over them needs a code from your
              email plus a hold to confirm. Set your limits on the Limits tab.
            </p>
          </div>
        </div>
      </div>

      {phase.k === "confirm" && recipient && (
        <ConfirmModal
          amount={amount}
          onConfirm={() => void afterHoldConfirm()}
          onClose={() => setPhase({ k: "idle" })}
          busy={busy}
        />
      )}

      {phase.k === "sendcode" && recipient && (
        <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Enter your code">
          <div className="l2 confirm-modal">
            <h2 style={{ margin: 0 }}>Enter your code</h2>
            <p className="muted" style={{ margin: "8px 0 0" }}>
              {phase.sending && !phase.error ? (
                <><Spinner /> Emailing a code to your recovery address…</>
              ) : (
                <>Enter the 6-digit code we emailed you to send <b>{amount} ETH</b>. Your passkey
                approves the send next.</>
              )}
            </p>
            <input
              type="text"
              inputMode="numeric"
              className="memo-input"
              placeholder="6-digit code"
              value={phase.code}
              maxLength={6}
              disabled={phase.sending}
              onChange={(e) => setPhase({ ...phase, code: e.target.value.replace(/\D/g, ""), error: undefined })}
              style={{ marginTop: 12 }}
            />
            {phase.error && <div className="errbox" style={{ marginTop: 8 }}>{phase.error}</div>}
            <button
              className="primary wide"
              disabled={phase.sending || phase.code.trim().length < 6}
              onClick={() => void doSend(phase.code.trim())}
              style={{ marginTop: 14 }}
            >
              {phase.sending ? "Sending…" : "Confirm and send"}
            </button>
            <button className="secondary" disabled={phase.sending} onClick={() => setPhase({ k: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
