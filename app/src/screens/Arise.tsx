import { useEffect, useState } from "react";
import { encodeAbiParameters, isAddress, keccak256, parseEther, type Hex } from "viem";
import { api } from "../api";
import { accountNonce, computeChallenge, watchReceipt, type Call } from "../chain";
import { capForAccount } from "../execute";
import { assertWithPasskey, createPasskey, type PasskeyInfo } from "../webauthn";
import {
  activeAccount,
  DEMO_ACCOUNT,
  EXPLORER,
  setActiveAccount,
  storedCredential,
  storeCredential,
} from "../config";
import { SealStamp, SuccessCheck, Spinner, shortAddr } from "../ui";
import { useToast, type TxToast } from "../toast";
import { recordSend } from "../stats";
import { humanError, isUserCancel } from "../errors";

/** The account being recovered — resolved from the address/name the user enters,
 *  NOT the active session account. Recovery happens on a fresh device with
 *  nothing loaded, so Arise must be told which account to recover. */
interface Target {
  address: Hex;
  upId: string | null;
}

type Stage =
  | { k: "identify" }
  | { k: "found" }
  | { k: "created"; key: PasskeyInfo }
  | { k: "code-sent"; key: PasskeyInfo; expiresAt: number }
  | { k: "arisen"; key: PasskeyInfo; txHash: Hex; ms: number }
  | { k: "error"; message: string };

interface ProofState {
  old?: { ok: boolean; detail: string };
  fresh?: { ok: boolean; detail: string; ms?: number };
}

/** R5: recovery really is a sequence — the numbered rail earns its place. */
const STEPS = ["Find account", "New passkey", "Request code", "Enter code & arise"];
const STAGE_IDX: Record<string, number> = { identify: 0, found: 1, created: 2, "code-sent": 3, arisen: 4 };

function stepState(stage: Stage, i: number): "done" | "active" | "todo" {
  if (stage.k === "arisen") return "done";
  const current = STAGE_IDX[stage.k] ?? 0;
  if (i < current) return "done";
  if (i === current) return "active";
  return "todo";
}

export function Arise({ refresh, onDone }: { refresh: () => void; onDone?: () => void }) {
  const [stage, setStage] = useState<Stage>({ k: "identify" });
  const [busy, setBusy] = useState<string | null>(null);
  // Prefill with the active account only when it's a real, non-demo account
  // (e.g. arrived here from the switcher's "Recover"); a fresh session is blank.
  const [input, setInput] = useState(() => {
    const a = activeAccount();
    return a && a.toLowerCase() !== DEMO_ACCOUNT.toLowerCase() ? (a as string) : "";
  });
  const [target, setTarget] = useState<Target | null>(null);
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [proof, setProof] = useState<ProofState>({});
  const [oldCredentialId] = useState(() => storedCredential());
  const toast = useToast();

  /** Step 0: resolve the account to recover and confirm it can be recovered. */
  const identify = async () => {
    const q = input.trim();
    if (!q) {
      setStage({ k: "error", message: "Enter the address or up.id name of the account to recover." });
      return;
    }
    setBusy("Looking up the account on GIWA…");
    try {
      let address: Hex | null = null;
      if (isAddress(q)) address = q as Hex;
      else {
        const r = await api.resolve(q);
        address = (r.address as Hex) ?? null;
      }
      if (!address) {
        setStage({ k: "error", message: "No account found for that name or address." });
        return;
      }
      const st = await api.status(address);
      if (!st.isOndolAccount) {
        setStage({ k: "error", message: "That address is not a Suho account on GIWA." });
        return;
      }
      const rec = await api.recoveryStatus(address);
      if (!rec.enabled) {
        setStage({
          k: "error",
          message:
            "This account has no recovery email set, so it can't be recovered. Recovery must be enabled before a device is lost.",
        });
        return;
      }
      setTarget({ address, upId: st.upId });
      setStage({ k: "found" });
    } catch (e) {
      setStage({ k: "error", message: humanError(e).text });
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (stage.k !== "code-sent") return;
    const t = window.setInterval(() => {
      setCountdown(Math.max(0, stage.expiresAt - Math.floor(Date.now() / 1000)));
    }, 500);
    return () => window.clearInterval(t);
  }, [stage]);

  const createNew = async () => {
    if (!target) return;
    setBusy("Waiting for Windows Hello. This is the new device's passkey…");
    try {
      // user.name carries the FULL account address (plus the up.id when known)
      // so the device credential manager doubles as an address backup. The
      // shorter displayName stays readable in the OS chooser.
      const { address, upId } = target;
      const name = upId ? `${upId}.up.id · ${address}` : address;
      const key = await createPasskey(name, upId ? `${upId}.up.id` : shortAddr(address));
      setStage({ k: "created", key });
    } catch (e) {
      if (isUserCancel(e)) {
        // Account is still identified; return to the create-passkey step.
        setStage({ k: "found" });
        toast.note("Canceled.");
      } else {
        setStage({ k: "error", message: humanError(e).text });
      }
    } finally {
      setBusy(null);
    }
  };

  const requestCode = async (key: PasskeyInfo) => {
    if (!target) return;
    setBusy("Emailing a recovery code to the address on file…");
    try {
      const newPubKeyHash = keccak256(
        encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [key.x, key.y]),
      );
      // H3: the response is generic (no enumeration); the code arrives by email.
      // Soft client-side expiry (~10 min) mirrors the on-chain code lifetime.
      await api.ariseRequest(target.address, newPubKeyHash);
      setCode("");
      setStage({ k: "code-sent", key, expiresAt: Math.floor(Date.now() / 1000) + 600 });
    } catch (e) {
      setStage({ k: "error", message: humanError(e).text });
    } finally {
      setBusy(null);
    }
  };

  const complete = async (key: PasskeyInfo) => {
    if (!target) return;
    setBusy("Submitting arise()…");
    // Button says "Arise"; the toast continues the verb through the lifecycle.
    const handle = toast.begin("Rising…");
    try {
      const t0 = performance.now();
      const r = await api.ariseComplete(target.address, key.x, key.y, code);
      const timing = await watchReceipt(r.txHash, t0, {
        preconf: (ms) => handle.preconfirmed("You have risen", ms),
        final: () => handle.final(r.txHash),
        reverted: () => handle.error(new Error("TransactionReverted")),
      });
      // The recovered account + its new passkey become the active session so the
      // fresh device can use it immediately.
      storeCredential(target.address, key.credentialId);
      setActiveAccount(target.address);
      setStage({ k: "arisen", key, txHash: r.txHash, ms: timing.preconfMs });
      refresh();
    } catch (e) {
      handle.error(e); // CodeInvalid/CodeExpired -> sentences; entry stays open
    } finally {
      setBusy(null);
    }
  };

  /** Prove-it panel: a real 0.0001 ETH send to suho.up.id with either key. */
  const proveSend = async (credentialId: string, label: "old" | "fresh") => {
    if (!target) return;
    const account = target.address;
    setBusy(label === "old" ? "Trying the OLD passkey…" : "Sending with the NEW passkey…");
    let handle: TxToast | null = null;
    try {
      const dest = (await api.resolve("suho")).address!;
      const calls: Call[] = [{ target: dest, value: parseEther("0.0001"), data: "0x" }];
      const [nonce, maxGasPayment] = await Promise.all([
        accountNonce(account),
        capForAccount(account),
      ]);
      const challenge = computeChallenge(account, nonce, calls, maxGasPayment);
      const webauthn = await assertWithPasskey(credentialId, challenge);
      handle = toast.begin("Sending 0.0001 ETH to suho.up.id…");
      const h = handle;
      const t0 = performance.now();
      const { txHash } = await api.relay(
        account,
        calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })),
        "",
        webauthn,
        maxGasPayment?.toString(),
      );
      const timing = await watchReceipt(txHash, t0, {
        preconf: (ms) => h.preconfirmed("Sent", ms),
        final: () => h.final(txHash),
        reverted: () => h.error(new Error("TransactionReverted")),
      });
      recordSend(txHash, timing.preconfMs);
      setProof((p) => ({
        ...p,
        [label]: {
          ok: true,
          detail: `sent · ${shortAddr(txHash)} (${(timing.preconfMs / 1000).toFixed(1)}s)`,
          ms: timing.preconfMs,
        },
      }));
      refresh();
    } catch (e) {
      if (isUserCancel(e)) {
        handle?.dismiss();
        toast.note("Canceled.");
      } else {
        // Old-key rejection: the toast reads "This passkey can't sign for the
        // account." The panel below interprets what that proves.
        handle?.error(e);
        setProof((p) => ({ ...p, [label]: { ok: false, detail: humanError(e).text } }));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="screen-head">
        <p className="eyebrow">RECOVERY</p>
        <h1 className="screen-title">Arise</h1>
      </div>

      <div className="arise-layout">
        <div className="step-rail" aria-label="Recovery steps">
          {STEPS.map((label, i) => {
            const s = stepState(stage, i);
            return (
              <div key={label} className={`step ${s}`}>
                <span className="step-num">{s === "done" ? "✓" : i + 1}</span>
                <span className="step-label">{label}</span>
              </div>
            );
          })}
        </div>

        <div>
          {stage.k !== "arisen" && (
            <div className="card">
              <h2>Lost your device?</h2>
              <p className="muted">
                Arise moves an account to a new passkey. One single-use code, bound to this exact recovery, authorizes it. Start by telling us which account to recover.
              </p>

              {stage.k === "identify" && (
                <>
                  <input
                    type="text"
                    placeholder="0x address or name.up.id of the account"
                    value={input}
                    aria-label="Account to recover"
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !busy && identify()}
                  />
                  <p className="muted" style={{ fontSize: "0.85rem", marginTop: 8 }}>
                    The recovery code is emailed to the address bound to that account — you don't
                    need anything from the lost device.
                  </p>
                  <button className="primary wide" onClick={identify} disabled={!!busy}>
                    Find account
                  </button>
                </>
              )}

              {stage.k === "found" && target && (
                <>
                  <p className="okbox">
                    ✓ {target.upId ? `${target.upId}.up.id` : shortAddr(target.address)} — recovery is
                    enabled. The code goes to the recovery email on file.
                  </p>
                  <p className="mono muted" style={{ fontSize: "0.8rem" }}>{target.address}</p>
                  <button className="primary wide" onClick={createNew} disabled={!!busy}>
                    Create new passkey
                  </button>
                  <button
                    className="switch-link"
                    onClick={() => {
                      setTarget(null);
                      setStage({ k: "identify" });
                    }}
                    disabled={!!busy}
                  >
                    Recover a different account
                  </button>
                </>
              )}

              {stage.k === "created" && (
                <>
                  <p className="okbox">✓ New passkey minted (P-256).</p>
                  <p className="mono muted">x: {stage.key.x.slice(0, 22)}…</p>
                  <button className="primary wide" onClick={() => requestCode(stage.key)} disabled={!!busy}>
                    Request recovery code
                  </button>
                </>
              )}

              {stage.k === "code-sent" && (
                <>
                  <p className="muted">
                    A 6-digit code is on its way to <b>the recovery email on file</b>. Enter it below.
                    Nothing is shown here — the code only reaches the bound email.
                  </p>
                  <input
                    type="text"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "1.5rem", letterSpacing: "0.5em", textAlign: "center" }}
                    maxLength={6}
                    inputMode="numeric"
                    value={code}
                    aria-label="Recovery code"
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  />
                  <div className="countdown">
                    {countdown > 0
                      ? `code expires in ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, "0")}`
                      : "This code has expired."}
                  </div>
                  {countdown > 0 ? (
                    <button
                      className="primary wide"
                      disabled={code.length !== 6 || !!busy}
                      onClick={() => complete(stage.key)}
                    >
                      Arise
                    </button>
                  ) : (
                    <button
                      className="primary wide"
                      disabled={!!busy}
                      onClick={() => requestCode(stage.key)}
                    >
                      Request a new code
                    </button>
                  )}
                </>
              )}

              {stage.k === "error" && (
                <>
                  <div className="errbox">{stage.message}</div>
                  <button
                    className="primary wide"
                    style={{ marginTop: 12 }}
                    onClick={() => {
                      setTarget(null);
                      setStage({ k: "identify" });
                    }}
                  >
                    Start over
                  </button>
                </>
              )}
            </div>
          )}

          {stage.k === "arisen" && (
            <>
              <div className="card center">
                <SealStamp label="Recovered" />
                <div className="hero">You have risen.</div>
                <p className="muted">Same address and name, new key.</p>
                <p className="mono muted">
                  arise tx:{" "}
                  <a href={`${EXPLORER}/tx/${stage.txHash}`} target="_blank" rel="noreferrer">
                    {shortAddr(stage.txHash)}
                  </a>{" "}
                  {stage.ms > 0 && <span className="timing">· confirmed in {(stage.ms / 1000).toFixed(1)}s</span>}
                </p>
                {onDone && (
                  <button className="primary wide" style={{ marginTop: 16 }} onClick={onDone}>
                    Open wallet
                  </button>
                )}
              </div>

              {/* R5: prove-it as two side-by-side L1 cards */}
              <div className="prove-grid">
                <div className="card hover prove-card">
                  <div className="prove-mark no">✗</div>
                  <h2>Old passkey</h2>
                  <p className="muted">Should be rejected on-chain. The rotation is real.</p>
                  {oldCredentialId && oldCredentialId !== stage.key.credentialId ? (
                    <>
                      <button
                        className="secondary danger-outline"
                        onClick={() => proveSend(oldCredentialId, "old")}
                        disabled={!!busy}
                      >
                        Try sending with it
                      </button>
                      {proof.old && (
                        <div className={proof.old.ok ? "errbox" : "okbox"}>
                          {proof.old.ok
                            ? `unexpected: ${proof.old.detail}`
                            : `✗ rejected: ${proof.old.detail}. The old key is dead.`}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="muted">(no old credential on this device)</p>
                  )}
                </div>
                <div className="card hover prove-card">
                  <div className="prove-mark yes"><SuccessCheck size={26} /></div>
                  <h2>New passkey</h2>
                  <p className="muted">Sends normally. Same address, new authority.</p>
                  <button
                    className="secondary"
                    onClick={() => proveSend(stage.key.credentialId, "fresh")}
                    disabled={!!busy}
                  >
                    Send with it
                  </button>
                  {proof.fresh && (
                    <div className={proof.fresh.ok ? "okbox" : "errbox"}>
                      {proof.fresh.ok ? `✓ ${proof.fresh.detail}` : `failed: ${proof.fresh.detail}`}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {busy && (
            <div className="status-line">
              <Spinner /> {busy}
            </div>
          )}

          {stage.k !== "arisen" && (
            <div className="stat-grid" style={{ marginTop: 16 }}>
              <div className="stat-card">
                <div className="stat-label">Purpose-bound</div>
                <div style={{ fontSize: "0.88rem" }}>
                  The code commits to this account and the new key. It can't rotate in any other
                  key.
                </div>
                <div className="stat-sub">domain: suho.arise:&lt;account&gt;:&lt;keyhash&gt;</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Single-use</div>
                <div style={{ fontSize: "0.88rem" }}>
                  Consumed on-chain the moment it verifies. A replayed code is dead.
                </div>
                <div className="stat-sub">EAS attestation · verifyAndConsume</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Relayable</div>
                <div style={{ fontSize: "0.88rem" }}>
                  Anyone may relay the recovery. The code itself is the authority.
                </div>
                <div className="stat-sub">no gas needed on the lost account</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
