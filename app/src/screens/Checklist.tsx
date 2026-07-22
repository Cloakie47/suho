import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy } from "lucide-react";
import type { Hex } from "viem";
import { api, type Status } from "../api";
import { executeWithPasskey } from "../execute";
import { activeAccount, GUARDIAN } from "../config";
import { Seal, Spinner, fmtEth } from "../ui";
import { useToast, type TxToast } from "../toast";
import { isUserCancel } from "../errors";

export const LS_FIRST_SEND = "suho.firstSendDone";
const LS_RECOVERY_NOTE = "suho.recoveryNoteDismissed";

/** O5 step 4: guided setup — replaces empty states until the account is
 *  funded, verified, named, and has sent once. Not gamification: each step is
 *  a real on-chain milestone that flips to a seal-stamped done state. */
export function Checklist({ status, refresh }: { status: Status; refresh: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [noteDismissed, setNoteDismissed] = useState(
    () => localStorage.getItem(LS_RECOVERY_NOTE) === "1",
  );
  const toast = useToast();

  const account = activeAccount();
  const funded = BigInt(status.balance) > 0n;
  const verified = status.isVerified;
  const named = status.upId !== null;
  const sent = localStorage.getItem(LS_FIRST_SEND) === "1";
  const allDone = funded && verified && named && sent;

  useEffect(() => {
    QRCode.toDataURL(account, { margin: 1, width: 132, color: { dark: "#1b1917", light: "#ffffff" } })
      .then(setQr, () => setQr(null));
  }, [account]);

  if (allDone) {
    if (noteDismissed) return null;
    // O5 step 5: recovery honesty, once, dismissible.
    return (
      <div className="card" style={{ borderColor: "rgba(201,161,92,0.35)" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1, fontSize: "0.88rem" }}>
            Lost devices are recoverable via Arise while the testnet issuer operates.{" "}
            <b>Your passkey is the only key.</b>
          </div>
          <button
            className="toast-x"
            aria-label="Dismiss"
            onClick={() => {
              localStorage.setItem(LS_RECOVERY_NOTE, "1");
              setNoteDismissed(true);
            }}
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  const runCalls = async (
    kind: "verify" | "claim",
    pendingLabel: string,
    doneLabel: string,
    fetchCalls: () => Promise<{ calls: { target: Hex; value: string; data: Hex }[] }>,
  ) => {
    setBusy(kind);
    const h: { t: TxToast | null } = { t: null };
    try {
      const { calls } = await fetchCalls();
      await executeWithPasskey(
        calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data })),
        "",
        {
          sent: () => {
            h.t = toast.begin(pendingLabel);
          },
          preconf: (ms) => h.t?.preconfirmed(doneLabel, ms),
          final: (hash) => h.t?.final(hash),
          reverted: () => h.t?.error(new Error("TransactionReverted")),
        },
      );
      refresh();
    } catch (e) {
      if (isUserCancel(e)) {
        // Passkey prompt canceled. Not an error.
        h.t?.dismiss();
        toast.note("Canceled.");
      } else {
        // Every flow error goes through the toast's human-sentence mapping. A
        // fetch-phase failure (AlreadyVerified, NameTaken...) fires before the
        // `sent` hook, so open a carrier toast for it.
        (h.t ?? toast.begin(pendingLabel)).error(e);
      }
    } finally {
      setBusy(null);
    }
  };

  const StepMark = ({ done, n }: { done: boolean; n: number }) =>
    done ? (
      <span className="toast-seal">
        <Seal small />
      </span>
    ) : (
      <span className="step-num">{n}</span>
    );

  return (
    <div className="card">
      <h2>Finish setting up</h2>
      <div style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <StepMark done={funded} n={1} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Fund your account</div>
            {!funded ? (
              <>
                <div className="muted" style={{ margin: "4px 0" }}>
                  Send a little testnet ETH (≥0.002 covers verification) from the GIWA or Nodit
                  faucet.
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  {qr && <img src={qr} width={66} height={66} style={{ borderRadius: 8 }} alt="Account address QR" />}
                  <button
                    className="id-addr"
                    style={{ fontSize: "0.78rem" }}
                    onClick={async () => {
                      await navigator.clipboard.writeText(account).catch(() => {});
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {account} {copied ? <Check size={11} /> : <Copy size={11} />}
                  </button>
                </div>
              </>
            ) : (
              <div className="muted">{fmtEth(status.balance)} ETH ready.</div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <StepMark done={verified} n={2} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Get verified</div>
            {!verified ? (
              <>
                <div className="muted" style={{ margin: "4px 0" }}>
                  Your account attests itself with the testnet issuer (0.001 ETH fee, passkey-signed).
                </div>
                <button
                  className="primary"
                  disabled={!funded || busy !== null}
                  onClick={() =>
                    runCalls("verify", "Getting verified…", "Verified human", () => api.verifyMe(account))
                  }
                >
                  {busy === "verify" ? "Confirm with your passkey…" : "Verify me"}
                </button>
              </>
            ) : (
              <div className="muted">Dojang attestation · testnet issuer</div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <StepMark done={named} n={3} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Claim your name</div>
            {!named ? (
              <>
                <div className="muted" style={{ margin: "4px 0" }}>
                  Your up.id. Claimed by the account itself.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    placeholder="name (a–z, 0–9, min 3)"
                    value={label}
                    onChange={(e) => setLabel(e.target.value.toLowerCase())}
                    style={{ flex: 1 }}
                  />
                  <button
                    className="primary"
                    disabled={!verified || label.trim().length < 3 || busy !== null}
                    onClick={() =>
                      runCalls("claim", `Claiming ${label.trim()}.up.id…`, `${label.trim()}.up.id claimed`, () =>
                        api.claimName(account, label.trim()),
                      )
                    }
                  >
                    {busy === "claim" ? "Signing…" : "Claim"}
                  </button>
                </div>
              </>
            ) : (
              <div className="muted">{status.upId}.up.id is yours.</div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <StepMark done={sent} n={4} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Send your first guarded transfer</div>
            <div className="muted" style={{ margin: "4px 0" }}>
              Use the composer above. Try <b>suho</b>.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
