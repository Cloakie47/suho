import { useState } from "react";
import { api, type Status } from "../api";
import { createPasskey } from "../webauthn";
import { DEMO_ACCOUNT, EXPLORER, LS_CREDENTIAL } from "../config";
import { Seal, Spinner, shortAddr } from "../ui";

/** R5: no screen is a single element in a void — success is a two-col
 *  composition with a mini card preview on the right. */
function MiniCardPreview({ status }: { status: Status }) {
  return (
    <div className="vcard" aria-hidden="true" style={{ maxWidth: 360, margin: "0 auto" }}>
      <div className="vcard-head">
        {status.isVerified && <Seal />}
        <div>
          <div className="vcard-name">{status.upId ?? "Suho"}</div>
          <div className="vcard-upid">{status.upId ? `${status.upId}.up.id` : shortAddr(status.address)}</div>
        </div>
      </div>
      <div className="vcard-fields">
        <div>
          <span className="vcard-label">secured by</span> passkey · P-256
        </div>
        <div>
          <span className="vcard-label">recovery</span> Arise — one code, no seed phrase
        </div>
      </div>
      <div className="vcard-meta">
        <span className="ver">smart account</span>
        <span>GIWA Sepolia</span>
      </div>
    </div>
  );
}

export function Upgrade({ status, onDone }: { status: Status; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ txHash: string; code: string } | null>(null);
  const hasCredential = !!localStorage.getItem(LS_CREDENTIAL);

  const linkExisting = async () => {
    setBusy("Linking this device's passkey…");
    setError(null);
    try {
      const { credentialId } = await api.demoCredential();
      localStorage.setItem(LS_CREDENTIAL, credentialId);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const upgrade = async () => {
    setError(null);
    try {
      setBusy("Waiting for Windows Hello…");
      const passkey = await createPasskey("alice@suho");
      localStorage.setItem(LS_CREDENTIAL, passkey.credentialId);
      setBusy("Upgrading wallet on GIWA…");
      const res = await api.upgrade(DEMO_ACCOUNT, { x: passkey.x, y: passkey.y });
      setResult({ txHash: res.txHash, code: res.code });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const upgraded = status.isOndolAccount && status.initialized;

  return (
    <div>
      <div className="screen-head">
        <p className="eyebrow">ACCOUNT</p>
        <h1 className="screen-title">Upgrade</h1>
      </div>

      <div className="upgrade-layout">
        <div className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {upgraded || result ? (
            <>
              <div className="big-check">✓</div>
              <div className="hero center">Same address. Same name. New powers.</div>
              <p className="muted center">
                This address is now a smart account, secured by your passkey. The old key can go in
                a drawer.
              </p>
              {result && (
                <p className="mono muted center">
                  delegation:{" "}
                  <a href={`${EXPLORER}/tx/${result.txHash}`} target="_blank" rel="noreferrer">
                    {shortAddr(result.txHash)}
                  </a>
                </p>
              )}
              <p className="mono muted center">
                code:{" "}
                <a href={`${EXPLORER}/address/${status.address}`} target="_blank" rel="noreferrer">
                  0xef0100… (view on explorer)
                </a>
              </p>
              {!hasCredential && !result && (
                <button className="primary wide" onClick={linkExisting} disabled={!!busy}>
                  {busy ?? "Use this device's passkey"}
                </button>
              )}
              {(hasCredential || result) && (
                <button className="primary wide" onClick={onDone}>
                  Continue
                </button>
              )}
            </>
          ) : (
            <>
              <div className="hero">Upgrade to Suho</div>
              <p className="muted">
                Create a passkey, then upgrade this wallet in place — keeping your verified identity
                and your up.id name.
              </p>
              <button className="primary wide" onClick={upgrade} disabled={!!busy}>
                {busy ?? "Create your Suho passkey & upgrade"}
              </button>
            </>
          )}
          {busy && (
            <div className="status-line">
              <Spinner /> {busy}
            </div>
          )}
          {error && <div className="errbox">{error}</div>}
        </div>

        <div className="card" style={{ display: "grid", placeItems: "center", background: "rgba(18,17,16,0.4)" }}>
          <MiniCardPreview status={status} />
        </div>
      </div>

      <div className="stat-grid" style={{ marginTop: 16 }}>
        <div className="stat-card">
          <div className="stat-label">Same address</div>
          <div style={{ fontSize: "0.88rem" }}>
            EIP-7702 upgrades the account in place — Dojang attestation and up.id survive.
          </div>
          <div className="stat-sub">type-4 delegation · 0xef0100 code</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Passkey signs</div>
          <div style={{ fontSize: "0.88rem" }}>
            Day-to-day authority is a WebAuthn P-256 key; the EOA key goes in a drawer.
          </div>
          <div className="stat-sub">P256VERIFY · native precompile</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Recoverable</div>
          <div style={{ fontSize: "0.88rem" }}>
            A lost device is one verification code from a new passkey — no seed phrase.
          </div>
          <div className="stat-sub">Arise · single-use codes</div>
        </div>
      </div>
    </div>
  );
}
