import { useEffect, useState } from "react";
import { ShieldCheck, Lock, Mail, KeyRound } from "lucide-react";
import { api, type Status } from "../api";
import { requireActiveAccount } from "../config";
import { humanError, isUserCancel } from "../errors";
import { useToast } from "../toast";
import { Spinner } from "../ui";
import {
  isV4,
  upgradeToV4,
  enableSensitiveOpLock,
  disableSensitiveOpLock,
  enableEmailLargeSendLock,
  disableEmailLargeSendLock,
  requestOpCode,
} from "../locks";

/// Phase SEC 2.3 settings. Functional and intentionally lean: the full design
/// lands with the UI restructure, so the lock screens are drawn once inside the
/// new layout. Two independent, opt-in email second factors:
///   - control lock: gates setGuard / upgrade / disabling behind an emailed code.
///   - large-send check: gates a large unverified send behind an emailed code.

type Flow =
  | { k: "idle" }
  | { k: "busy"; note: string }
  | { k: "code"; which: "control" | "send"; code: string; error?: string; sending?: boolean };

export function Locks({ status, refresh }: { status: Status; refresh: () => void }) {
  const account = requireActiveAccount();
  const v4 = isV4(status);
  const locks = status.locks ?? { sensitiveOpLock: false, emailLargeSendLock: false, sensitiveOpNonce: "0" };
  const [recoveryOn, setRecoveryOn] = useState<boolean | null>(null);
  const [flow, setFlow] = useState<Flow>({ k: "idle" });
  const toast = useToast();

  useEffect(() => {
    api.recoveryStatus(account).then((r) => setRecoveryOn(r.enabled), () => setRecoveryOn(null));
  }, [account]);

  const run = async (note: string, fn: () => Promise<unknown>) => {
    setFlow({ k: "busy", note });
    try {
      await fn();
      toast.note("Done.");
      refresh();
      setFlow({ k: "idle" });
    } catch (e) {
      if (isUserCancel(e)) setFlow({ k: "idle" });
      else {
        toast.note(humanError(e).text);
        setFlow({ k: "idle" });
      }
    }
  };

  const startDisable = async (which: "control" | "send") => {
    // A code is only needed when the CONTROL lock is on (disabling the send lock
    // alone, with control off, is passkey-only). But the guardian gates on the
    // account being locked; request a code whenever control is on.
    if (locks.sensitiveOpLock) {
      setFlow({ k: "code", which, code: "", sending: true });
      try {
        await requestOpCode(account, which === "control" ? "disablelock" : "disablesendlock");
        setFlow({ k: "code", which, code: "" });
      } catch (e) {
        if (isUserCancel(e)) setFlow({ k: "idle" });
        else setFlow({ k: "code", which, code: "", error: humanError(e).text });
      }
    } else {
      // control off: the send lock disables on passkey authority alone
      await run("Turning off the large-send check…", () => disableEmailLargeSendLock(account, ""));
    }
  };

  const submitCode = async () => {
    if (flow.k !== "code") return;
    const which = flow.which;
    const code = flow.code.trim();
    setFlow({ k: "code", which, code, sending: true });
    try {
      if (which === "control") await disableSensitiveOpLock(account, code);
      else await disableEmailLargeSendLock(account, code);
      toast.note("Turned off.");
      refresh();
      setFlow({ k: "idle" });
    } catch (e) {
      if (isUserCancel(e)) setFlow({ k: "code", which, code });
      else setFlow({ k: "code", which, code, error: humanError(e).text });
    }
  };

  const busy = flow.k === "busy";

  return (
    <div>
      <div className="screen-head">
        <p className="eyebrow">EXTRA PROTECTION</p>
        <h1 className="screen-title">If your device is stolen</h1>
      </div>
      <p className="muted" style={{ margin: "-14px 0 22px", maxWidth: 620 }}>
        A thief holding your unlocked device can pass every passkey prompt. These locks add a second
        factor they don't have: a code sent to your recovery email.
      </p>

      {!v4 && (
        <div className="card">
          <div className="lock-row">
            <ShieldCheck size={20} strokeWidth={1.5} />
            <div>
              <div className="lock-title">Turn on the email second factor</div>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                Upgrade this account to add an out-of-band email code for sensitive actions. A stolen
                passkey alone can no longer repoint your guard, upgrade your account, or send large
                amounts to strangers.
              </p>
            </div>
          </div>
          <button className="primary wide" disabled={busy} onClick={() => run("Upgrading account…", () => upgradeToV4(account))}>
            {busy ? "Working…" : "Upgrade this account"}
          </button>
        </div>
      )}

      {v4 && (
        <>
          {recoveryOn === false && (
            <div className="warnbox" style={{ marginBottom: 14 }}>
              Set a recovery email first (in your account setup). The codes for these locks are sent
              there, and without one a lock can only be lifted through Arise recovery.
            </div>
          )}

          <LockCard
            icon={<Lock size={20} strokeWidth={1.5} />}
            title="Control lock"
            body="Protects the account itself. Changing the guard, upgrading the account, or turning this off needs an emailed code, not just the passkey."
            on={locks.sensitiveOpLock}
            canEnable={recoveryOn === true}
            busy={busy}
            onEnable={() => run("Turning on the control lock…", () => enableSensitiveOpLock(account))}
            onDisable={() => startDisable("control")}
          />

          <LockCard
            icon={<Mail size={20} strokeWidth={1.5} />}
            title="Large-send email check"
            body="Protects your funds. A large send to an unverified address needs an emailed code. ETH only for now."
            on={locks.emailLargeSendLock}
            canEnable={recoveryOn === true}
            busy={busy}
            onEnable={() => run("Turning on the large-send check…", () => enableEmailLargeSendLock(account))}
            onDisable={() => startDisable("send")}
          />

          <p className="muted" style={{ fontSize: "0.82rem", marginTop: 12 }}>
            These protect you if your device passkey is stolen. They do not protect you if your
            recovery email is also compromised.
          </p>
        </>
      )}

      {flow.k === "code" && (
        <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Enter security code">
          <div className="l2 confirm-modal">
            <div className="lock-row">
              <KeyRound size={20} strokeWidth={1.5} />
              <h2 style={{ margin: 0 }}>Enter your security code</h2>
            </div>
            <p className="muted" style={{ margin: "8px 0 0" }}>
              {flow.sending && !flow.error ? (
                <><Spinner /> Sending a code to your recovery email…</>
              ) : (
                "We emailed a 6-digit code to your recovery address. Enter it to confirm."
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
            <button
              className="primary wide"
              disabled={flow.sending || flow.code.trim().length < 6}
              onClick={() => void submitCode()}
              style={{ marginTop: 14 }}
            >
              {flow.sending ? "Confirming…" : "Confirm"}
            </button>
            <button className="secondary" disabled={flow.sending} onClick={() => setFlow({ k: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LockCard({
  icon,
  title,
  body,
  on,
  canEnable,
  busy,
  onEnable,
  onDisable,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  on: boolean;
  canEnable: boolean;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
}) {
  return (
    <div className="card">
      <div className="lock-row">
        {icon}
        <div style={{ flex: 1 }}>
          <div className="lock-title">
            {title} <span className={on ? "lock-badge on" : "lock-badge"}>{on ? "On" : "Off"}</span>
          </div>
          <p className="muted" style={{ margin: "4px 0 0" }}>{body}</p>
        </div>
      </div>
      {on ? (
        <button className="secondary" disabled={busy} onClick={onDisable}>Turn off</button>
      ) : (
        <button className="primary wide" disabled={busy || !canEnable} onClick={onEnable}>
          {canEnable ? "Turn on" : "Recovery email needed"}
        </button>
      )}
    </div>
  );
}
