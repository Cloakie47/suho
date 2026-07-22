import { useEffect, useState } from "react";
import { encodeAbiParameters, keccak256, parseEther, type Hex } from "viem";
import { api, GuardianError, type Status } from "../api";
import { accountNonce, computeChallenge, watchReceipt, type Call } from "../chain";
import { assertWithPasskey, createPasskey, type PasskeyInfo } from "../webauthn";
import { activeAccount, EXPLORER, GUARDIAN, storedCredential, storeCredential } from "../config";
import { Spinner, shortAddr } from "../ui";
import { useToast, type TxToast } from "../toast";
import { recordSend } from "../stats";
import { humanError } from "../errors";

type Stage =
  | { k: "intro" }
  | { k: "created"; key: PasskeyInfo }
  | { k: "code-sent"; key: PasskeyInfo; expiresAt: number }
  | { k: "arisen"; key: PasskeyInfo; txHash: Hex; ms: number }
  | { k: "error"; message: string };

interface ProofState {
  old?: { ok: boolean; detail: string };
  fresh?: { ok: boolean; detail: string; ms?: number };
}

/** R5: recovery really is a sequence — the numbered rail earns its place. */
const STEPS = ["New passkey", "Request code", "Enter code & arise"];

function stepState(stage: Stage, i: number): "done" | "active" | "todo" {
  const current = stage.k === "intro" ? 0 : stage.k === "created" ? 1 : stage.k === "code-sent" ? 2 : 3;
  if (stage.k === "arisen") return "done";
  if (i < current) return "done";
  if (i === current) return "active";
  return "todo";
}

export function Arise({ status, refresh }: { status: Status; refresh: () => void }) {
  const [stage, setStage] = useState<Stage>({ k: "intro" });
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [proof, setProof] = useState<ProofState>({});
  const [oldCredentialId] = useState(() => storedCredential());
  const toast = useToast();

  useEffect(() => {
    if (stage.k !== "code-sent") return;
    const t = window.setInterval(() => {
      setCountdown(Math.max(0, stage.expiresAt - Math.floor(Date.now() / 1000)));
    }, 500);
    return () => window.clearInterval(t);
  }, [stage]);

  const createNew = async () => {
    setBusy("Waiting for Windows Hello. This is the new device's passkey…");
    try {
      // Label the new passkey with the account's up.id so it is identifiable
      // in the device credential manager (falls back to the address).
      const label = status.upId ? `${status.upId}.up.id` : shortAddr(activeAccount());
      const key = await createPasskey(label);
      setStage({ k: "created", key });
    } catch (e) {
      setStage({ k: "error", message: humanError(e).text });
    } finally {
      setBusy(null);
    }
  };

  const requestCode = async (key: PasskeyInfo) => {
    setBusy("Requesting recovery code from the verification service…");
    try {
      const newPubKeyHash = keccak256(
        encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [key.x, key.y]),
      );
      const r = await api.ariseRequest(activeAccount(), newPubKeyHash);
      setCode("");
      setStage({ k: "code-sent", key, expiresAt: r.expiresAt });
    } catch (e) {
      setStage({ k: "error", message: humanError(e).text });
    } finally {
      setBusy(null);
    }
  };

  const complete = async (key: PasskeyInfo) => {
    setBusy("Submitting arise()…");
    // Button says "Arise"; the toast continues the verb through the lifecycle.
    const handle = toast.begin("Rising…");
    try {
      const t0 = performance.now();
      const r = await api.ariseComplete(activeAccount(), key.x, key.y, code);
      const timing = await watchReceipt(r.txHash, t0, {
        preconf: (ms) => handle.preconfirmed("You have risen", ms),
        final: () => handle.final(r.txHash),
        reverted: () => handle.error(new Error("TransactionReverted")),
      });
      storeCredential(activeAccount(), key.credentialId);
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
    setBusy(label === "old" ? "Trying the OLD passkey…" : "Sending with the NEW passkey…");
    let handle: TxToast | null = null;
    try {
      const target = (await api.resolve("suho")).address!;
      const calls: Call[] = [{ target, value: parseEther("0.0001"), data: "0x" }];
      const nonce = await accountNonce(activeAccount());
      const challenge = computeChallenge(activeAccount(), nonce, calls);
      const webauthn = await assertWithPasskey(credentialId, challenge);
      handle = toast.begin("Sending 0.0001 ETH to suho.up.id…");
      const h = handle;
      const t0 = performance.now();
      const { txHash } = await api.relay(
        activeAccount(),
        calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })),
        "",
        webauthn,
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
      // Old-key rejection: the toast reads "This passkey can't sign for the
      // account." — the panel below interprets what that proves.
      handle?.error(e);
      const msg = e instanceof GuardianError ? e.message : String(e);
      setProof((p) => ({ ...p, [label]: { ok: false, detail: msg } }));
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
                Arise moves your account to a new passkey. One single-use code, bound to this exact recovery, authorizes it.
              </p>

              {stage.k === "intro" && (
                <button className="primary wide" onClick={createNew} disabled={!!busy}>
                  Create new passkey
                </button>
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
                    Read the 6-digit code from the{" "}
                    <a href={`${GUARDIAN}/issuer`} target="_blank" rel="noreferrer">
                      verification service
                    </a>
                    .
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
                      : "code expired. Request a new one."}
                  </div>
                  <button
                    className="primary wide"
                    disabled={code.length !== 6 || countdown === 0 || !!busy}
                    onClick={() => complete(stage.key)}
                  >
                    Arise
                  </button>
                </>
              )}

              {stage.k === "error" && <div className="errbox">{stage.message}</div>}
            </div>
          )}

          {stage.k === "arisen" && (
            <>
              <div className="card center">
                <div className="big-check">✓</div>
                <div className="hero">You have risen.</div>
                <p className="muted">Same address and name, new key.</p>
                <p className="mono muted">
                  arise tx:{" "}
                  <a href={`${EXPLORER}/tx/${stage.txHash}`} target="_blank" rel="noreferrer">
                    {shortAddr(stage.txHash)}
                  </a>{" "}
                  {stage.ms > 0 && <span className="timing">· confirmed in {(stage.ms / 1000).toFixed(1)}s</span>}
                </p>
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
                  <div className="prove-mark yes">✓</div>
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
