import { useState } from "react";
import { api, type Status } from "../api";
import { createPasskey } from "../webauthn";
import { DEMO_ACCOUNT, EXPLORER, LS_CREDENTIAL } from "../config";
import { Seal, Spinner, TileDivider, fmtEth, shortAddr } from "../ui";

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
      <div className="card">
        <h2>Your wallet</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {status.isVerified && <Seal />}
          <div>
            <div className="name" style={{ fontWeight: 600 }}>
              {status.upId ? `${status.upId}.up.id` : shortAddr(status.address)}
            </div>
            <div className="muted mono">{status.address}</div>
          </div>
        </div>
        <div className="balance" style={{ marginTop: 10 }}>
          {fmtEth(status.balance)} <small>ETH</small>
        </div>
        {status.isVerified && (
          <div className="muted">Identity verified by {status.verifiedBy} · Dojang attestation</div>
        )}
      </div>

      <TileDivider />

      {upgraded || result ? (
        <div className="card center">
          <div className="big-check">✓</div>
          <div className="hero">Same address. Same name. New powers.</div>
          <p className="muted">
            This address is now a smart account, secured by your passkey. The old key can go in a
            drawer.
          </p>
          {result && (
            <p className="mono muted">
              delegation: <a href={`${EXPLORER}/tx/${result.txHash}`} target="_blank">{shortAddr(result.txHash)}</a>
            </p>
          )}
          <p className="mono muted">
            code:{" "}
            <a href={`${EXPLORER}/address/${status.address}`} target="_blank">
              0xef0100… (view on explorer)
            </a>
          </p>
          {!hasCredential && !result && (
            <button className="primary" onClick={linkExisting} disabled={!!busy}>
              {busy ?? "Use this device's passkey"}
            </button>
          )}
          {(hasCredential || result) && (
            <button className="primary" onClick={onDone}>
              Continue
            </button>
          )}
        </div>
      ) : (
        <div className="card center">
          <div className="hero">Upgrade to Suho</div>
          <p className="muted">
            Create a passkey, then upgrade this wallet in place — keeping your verified identity and
            your up.id name.
          </p>
          <button className="primary" onClick={upgrade} disabled={!!busy}>
            {busy ?? "Create your Suho passkey & upgrade"}
          </button>
        </div>
      )}

      {busy && (
        <div className="status-line">
          <Spinner /> {busy}
        </div>
      )}
      {error && <div className="errbox">{error}</div>}
    </div>
  );
}
