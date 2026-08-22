import { useCallback, useEffect, useState } from "react";
import { parseEther, formatEther, type Hex } from "viem";
import { api, type Status } from "../api";
import { requireActiveAccount } from "../config";
import { readSpending } from "../chain";
import { requestLimitCode, setLimits, isRaise, UNLIMITED } from "../spending";
import { humanError, isUserCancel } from "../errors";
import { useToast } from "../toast";
import { Spinner, ResetsIn } from "../ui";

/// The Limits screen (bank model). Rules the OWNER sets: send up to these amounts
/// on the passkey alone; going over them, or raising them, needs a code from the
/// recovery email. No "protection/security lock" vocabulary — just your limits.

interface Spend {
  perTx: bigint;
  daily: bigint;
  spent: bigint;
  remaining: bigint;
  windowStart: bigint;
}

type Flow =
  | { k: "idle" }
  | { k: "editing"; perTx: string; daily: string }
  | { k: "busy"; note: string }
  // Raising needs a code: we emailed one, now collect it and apply.
  | { k: "code"; perTx: bigint; daily: bigint; code: string; error?: string; sending?: boolean };

const fmt = (wei: bigint): string => (wei >= UNLIMITED ? "no cap" : `${trim(formatEther(wei))} ETH`);
const trim = (s: string): string => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

export function Limits({ status, refresh }: { status: Status; refresh: () => void }) {
  const account = requireActiveAccount();
  const [spend, setSpend] = useState<Spend | null>(null);
  const [recoveryOn, setRecoveryOn] = useState<boolean | null>(null);
  const [flow, setFlow] = useState<Flow>({ k: "idle" });
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setSpend(await readSpending(account));
    } catch (e) {
      toast.note(humanError(e).text);
    }
  }, [account, toast]);

  useEffect(() => {
    load();
    api.recoveryStatus(account).then((r) => setRecoveryOn(r.enabled), () => setRecoveryOn(null));
  }, [account, load]);

  const startEdit = () => {
    if (!spend) return;
    setFlow({ k: "editing", perTx: spend.perTx >= UNLIMITED ? "" : trim(formatEther(spend.perTx)), daily: spend.daily >= UNLIMITED ? "" : trim(formatEther(spend.daily)) });
  };

  const save = async () => {
    if (flow.k !== "editing" || !spend) return;
    let perTx: bigint;
    let daily: bigint;
    try {
      perTx = flow.perTx.trim() === "" ? UNLIMITED : parseEther(flow.perTx.trim());
      daily = flow.daily.trim() === "" ? UNLIMITED : parseEther(flow.daily.trim());
    } catch {
      toast.note("Enter amounts in ETH, like 0.05.");
      return;
    }
    if (perTx === 0n || daily === 0n) {
      toast.note("Limits must be above zero. Leave a field blank for no cap.");
      return;
    }
    if (isRaise(perTx, daily, spend.perTx, spend.daily)) {
      // A raise needs a code from the recovery email.
      if (recoveryOn !== true) {
        toast.note("Set a recovery email first to raise your limits.");
        return;
      }
      setFlow({ k: "code", perTx, daily, code: "", sending: true });
      try {
        await requestLimitCode(account, perTx, daily);
        setFlow({ k: "code", perTx, daily, code: "" });
      } catch (e) {
        if (isUserCancel(e)) setFlow({ k: "idle" });
        else setFlow({ k: "code", perTx, daily, code: "", error: humanError(e).text });
      }
      return;
    }
    // Lowering (strengthening): one passkey tap, no code.
    await run("Updating your limits…", () => setLimits(account, perTx, daily, ""));
  };

  const submitCode = async () => {
    if (flow.k !== "code") return;
    const { perTx, daily } = flow;
    const code = flow.code.trim();
    setFlow({ k: "code", perTx, daily, code, sending: true });
    try {
      await setLimits(account, perTx, daily, code);
      toast.note("Limits updated.");
      setFlow({ k: "idle" });
      await load();
      refresh();
    } catch (e) {
      if (isUserCancel(e)) setFlow({ k: "code", perTx, daily, code });
      else setFlow({ k: "code", perTx, daily, code, error: humanError(e).text });
    }
  };

  const run = async (note: string, fn: () => Promise<unknown>) => {
    setFlow({ k: "busy", note });
    try {
      await fn();
      toast.note("Limits updated.");
      setFlow({ k: "idle" });
      await load();
      refresh();
    } catch (e) {
      if (isUserCancel(e)) setFlow({ k: "idle" });
      else {
        toast.note(humanError(e).text);
        setFlow({ k: "idle" });
      }
    }
  };

  const busy = flow.k === "busy";

  return (
    <div>
      <div className="screen-head">
        <p className="eyebrow">WHAT YOU CAN SPEND</p>
        <h1 className="screen-title">Your spending limits</h1>
      </div>
      <p className="muted" style={{ margin: "-14px 0 22px", maxWidth: 620 }}>
        Send up to these amounts with just your passkey. Going over them, or raising them, needs a
        code from your email.
      </p>

      <div className="cols">
        <div className="main">
          {recoveryOn === false && (
            <div className="warnbox" style={{ marginBottom: 14 }}>
              Set a recovery email to authorize larger sends and to raise your limits. Until then this
              account is capped at the amounts below.
            </div>
          )}

          {!spend ? (
            <div className="status-line"><Spinner /> reading your limits…</div>
          ) : flow.k === "editing" ? (
            <div className="card">
              <h3>Edit limits</h3>
              <p className="explain" style={{ marginBottom: 12 }}>
                Lowering a limit takes effect on your next passkey tap. Raising one needs a code from
                your email. Leave a field blank for no cap.
              </p>
              <div style={{ display: "grid", gap: 10 }}>
                <label className="lim-field">
                  <span>Per send</span>
                  <input type="text" inputMode="decimal" placeholder="0.01" value={flow.perTx} onChange={(e) => setFlow({ ...flow, perTx: e.target.value })} aria-label="Per-send limit in ETH" />
                </label>
                <label className="lim-field">
                  <span>Per day</span>
                  <input type="text" inputMode="decimal" placeholder="0.02" value={flow.daily} onChange={(e) => setFlow({ ...flow, daily: e.target.value })} aria-label="Daily limit in ETH" />
                </label>
              </div>
              <button className="primary wide" onClick={save} disabled={busy}>Save limits</button>
              <button className="secondary" onClick={() => setFlow({ k: "idle" })} disabled={busy}>Cancel</button>
            </div>
          ) : (
            <div className="card">
              <div className="lim-row"><span className="lim-k">Per send</span><span className="lim-v">{fmt(spend.perTx)}</span></div>
              <div className="lim-row"><span className="lim-k">Per day</span><span className="lim-v">{fmt(spend.daily)}</span></div>
              <div className="lim-row"><span className="lim-k">Spent today</span><span className="lim-v">{fmt(spend.spent)}</span></div>
              <div className="lim-row"><span className="lim-k">Remaining today</span><span className="lim-v jade">{fmt(spend.remaining)}</span></div>
              {spend.daily < UNLIMITED && (
                <div className="lim-row"><span className="lim-k">Daily window</span><span className="lim-v muted"><ResetsIn windowStart={spend.windowStart} /></span></div>
              )}
              <button className="primary wide" onClick={startEdit} disabled={busy}>Edit limits</button>
            </div>
          )}

          {flow.k === "busy" && <div className="status-line"><Spinner /> {flow.note}</div>}
        </div>

        <div className="rail">
          <div className="card">
            <h3>How this works</h3>
            <p className="explain">
              Your passkey approves anything within these limits. A send over them, a change to these
              limits, or any change to your account needs a 6-digit code sent to your recovery email.
              A thief holding your device can spend at most what's left of today's limit, and can't
              raise it.
            </p>
          </div>
          <div className="card">
            <h3>What it can't do</h3>
            <p className="explain">
              Limits don't second-guess a payment you make on purpose. And if your recovery email is
              also taken, the code is gone too. On this testnet the seal shows who an address claims
              to be, not whether a payment is safe.
            </p>
          </div>
        </div>
      </div>

      {flow.k === "code" && (
        <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Enter your code">
          <div className="l2 confirm-modal">
            <h2 style={{ margin: 0 }}>Enter your code</h2>
            <p className="muted" style={{ margin: "8px 0 0" }}>
              {flow.sending && !flow.error ? (
                <><Spinner /> Emailing a code to your recovery address…</>
              ) : (
                <>Raising your limits to {fmt(flow.perTx)} per send and {fmt(flow.daily)} per day. Enter the 6-digit code from your email.</>
              )}
            </p>
            <input
              type="text"
              inputMode="numeric"
              className="memo-input"
              placeholder="6-digit code"
              value={flow.code}
              maxLength={6}
              disabled={flow.sending}
              onChange={(e) => setFlow({ ...flow, code: e.target.value.replace(/\D/g, ""), error: undefined })}
              style={{ marginTop: 12 }}
            />
            {flow.error && <div className="errbox" style={{ marginTop: 8 }}>{flow.error}</div>}
            <button className="primary wide" disabled={flow.sending || flow.code.trim().length < 6} onClick={() => void submitCode()} style={{ marginTop: 14 }}>
              {flow.sending ? "Working…" : "Raise limits"}
            </button>
            <button className="secondary" disabled={flow.sending} onClick={() => setFlow({ k: "idle" })}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
