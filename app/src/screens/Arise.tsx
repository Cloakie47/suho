import { useEffect, useState } from "react";
import { encodeAbiParameters, keccak256, parseEther, type Hex } from "viem";
import { api, GuardianError, type Status } from "../api";
import { accountNonce, computeChallenge, watchReceipt, type Call } from "../chain";
import { assertWithPasskey, createPasskey, type PasskeyInfo } from "../webauthn";
import { DEMO_ACCOUNT, EXPLORER, LS_CREDENTIAL } from "../config";
import { Spinner, TileDivider, shortAddr } from "../ui";

type Stage =
  | { k: "intro" }
  | { k: "created"; key: PasskeyInfo }
  | { k: "code-sent"; key: PasskeyInfo; expiresAt: number; error?: string }
  | { k: "arisen"; key: PasskeyInfo; txHash: Hex }
  | { k: "error"; message: string };

interface ProofState {
  old?: { ok: boolean; detail: string };
  fresh?: { ok: boolean; detail: string; ms?: number };
}

export function Arise({ status, refresh }: { status: Status; refresh: () => void }) {
  const [stage, setStage] = useState<Stage>({ k: "intro" });
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [proof, setProof] = useState<ProofState>({});
  const [oldCredentialId] = useState(() => localStorage.getItem(LS_CREDENTIAL));

  useEffect(() => {
    if (stage.k !== "code-sent") return;
    const t = window.setInterval(() => {
      setCountdown(Math.max(0, stage.expiresAt - Math.floor(Date.now() / 1000)));
    }, 500);
    return () => window.clearInterval(t);
  }, [stage]);

  const createNew = async () => {
    setBusy("Waiting for Windows Hello — this is the NEW device's passkey…");
    try {
      const key = await createPasskey("alice@suho (recovered)");
      setStage({ k: "created", key });
    } catch (e) {
      setStage({ k: "error", message: String(e) });
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
      const r = await api.ariseRequest(DEMO_ACCOUNT, newPubKeyHash);
      setCode("");
      setStage({ k: "code-sent", key, expiresAt: r.expiresAt });
    } catch (e) {
      setStage({ k: "error", message: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const complete = async (key: PasskeyInfo) => {
    setBusy("Submitting arise()…");
    try {
      const r = await api.ariseComplete(DEMO_ACCOUNT, key.x, key.y, code);
      localStorage.setItem(LS_CREDENTIAL, key.credentialId);
      setStage({ k: "arisen", key, txHash: r.txHash });
      refresh();
    } catch (e) {
      if (stage.k === "code-sent") {
        setStage({ ...stage, error: e instanceof GuardianError ? e.message : String(e) });
      }
    } finally {
      setBusy(null);
    }
  };

  /** Prove-it panel: a real 0.0001 ETH send to suho.up.id with either key. */
  const proveSend = async (credentialId: string, label: "old" | "fresh") => {
    setBusy(label === "old" ? "Trying the OLD passkey…" : "Sending with the NEW passkey…");
    try {
      const target = (await api.resolve("suho")).address!;
      const calls: Call[] = [{ target, value: parseEther("0.0001"), data: "0x" }];
      const nonce = await accountNonce(DEMO_ACCOUNT);
      const challenge = computeChallenge(DEMO_ACCOUNT, nonce, calls);
      const webauthn = await assertWithPasskey(credentialId, challenge);
      const t0 = performance.now();
      const { txHash } = await api.relay(
        DEMO_ACCOUNT,
        calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })),
        "",
        webauthn,
      );
      const timing = await watchReceipt(txHash, t0);
      setProof((p) => ({
        ...p,
        [label]: {
          ok: true,
          detail: `sent — ${shortAddr(txHash)} (${timing.preconfMs}ms)`,
          ms: timing.preconfMs,
        },
      }));
      refresh();
    } catch (e) {
      const msg = e instanceof GuardianError ? e.message : String(e);
      setProof((p) => ({ ...p, [label]: { ok: false, detail: msg } }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="card center">
        <div className="hero">Lost your device?</div>
        <p className="muted">
          Arise rotates your account to a new passkey — same address, same name — authorized only by
          a single-use verification code bound to this exact recovery.
        </p>
      </div>

      <TileDivider />

      {stage.k === "intro" && (
        <div className="card center">
          <p className="muted">Step 1 — create a passkey on the “new device”.</p>
          <button className="primary" onClick={createNew} disabled={!!busy}>
            Create new passkey
          </button>
        </div>
      )}

      {stage.k === "created" && (
        <div className="card center">
          <p className="okbox">✓ New passkey minted (P-256).</p>
          <p className="mono muted">x: {stage.key.x.slice(0, 22)}…</p>
          <p className="muted">Step 2 — request the recovery code.</p>
          <button className="primary" onClick={() => requestCode(stage.key)} disabled={!!busy}>
            Request recovery code
          </button>
        </div>
      )}

      {stage.k === "code-sent" && (
        <div className="card">
          <h2>Enter recovery code</h2>
          <p className="muted">
            Read the 6-digit code from the Upbit Verification Service terminal.
          </p>
          <input
            type="text"
            className="otp-input"
            maxLength={6}
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          <div className="countdown">
            {countdown > 0
              ? `code expires in ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, "0")}`
              : "code expired — go back and request a new one"}
          </div>
          {stage.error && <div className="errbox">{stage.error}</div>}
          <button
            className="primary"
            disabled={code.length !== 6 || countdown === 0 || !!busy}
            onClick={() => complete(stage.key)}
          >
            Arise
          </button>
        </div>
      )}

      {stage.k === "arisen" && (
        <div>
          <div className="card center">
            <div className="big-check">✓</div>
            <div className="hero">You have risen.</div>
            <p className="muted">Same address, same name, new key.</p>
            <p className="mono muted">
              arise tx:{" "}
              <a href={`${EXPLORER}/tx/${stage.txHash}`} target="_blank">
                {shortAddr(stage.txHash)}
              </a>
            </p>
          </div>
          <div className="card">
            <h2>Prove it</h2>
            {oldCredentialId && oldCredentialId !== stage.key.credentialId && (
              <>
                <button
                  className="secondary danger-outline"
                  onClick={() => proveSend(oldCredentialId, "old")}
                  disabled={!!busy}
                >
                  Try sending with the OLD passkey (should fail)
                </button>
                {proof.old && (
                  <div className={proof.old.ok ? "errbox" : "okbox"}>
                    {proof.old.ok
                      ? `unexpected: ${proof.old.detail}`
                      : `✗ rejected onchain: ${proof.old.detail} — the old key is dead`}
                  </div>
                )}
              </>
            )}
            <button
              className="secondary"
              onClick={() => proveSend(stage.key.credentialId, "fresh")}
              disabled={!!busy}
            >
              Send with the NEW passkey (should succeed)
            </button>
            {proof.fresh && (
              <div className={proof.fresh.ok ? "okbox" : "errbox"}>
                {proof.fresh.ok ? `✓ ${proof.fresh.detail}` : `failed: ${proof.fresh.detail}`}
              </div>
            )}
          </div>
        </div>
      )}

      {stage.k === "error" && <div className="errbox">{stage.message}</div>}
      {busy && (
        <div className="status-line">
          <Spinner /> {busy}
        </div>
      )}
    </div>
  );
}
