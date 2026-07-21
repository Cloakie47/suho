import { useCallback, useEffect, useState } from "react";
import { api, type Status } from "./api";
import { DEMO_ACCOUNT } from "./config";
import { Spinner } from "./ui";
import { Upgrade } from "./screens/Upgrade";
import { Send } from "./screens/Send";
import { Arise } from "./screens/Arise";
import { Directory } from "./screens/Directory";
import { Card } from "./screens/Card";
import { Verify } from "./screens/Verify";

type Screen = "upgrade" | "send" | "directory" | "card" | "arise";

export default function App() {
  const [screen, setScreen] = useState<Screen>("upgrade");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefillRecipient, setPrefillRecipient] = useState<string | null>(null);
  const [verifyId, setVerifyId] = useState<string | null>(null);

  // C5: hash route #/verify/<address-or-uid> renders the shareable read-only
  // view — no nav, no passkey, works from a clean session.
  useEffect(() => {
    const readHash = () => {
      const m = window.location.hash.match(/^#\/verify\/(.+)$/);
      setVerifyId(m ? m[1] : null);
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);


  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status(DEMO_ACCOUNT));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  if (verifyId) {
    return (
      <div className="column">
        <div className="topbar">
          <div className="brand">
            Suho<span className="hanja">수호</span>
          </div>
          <span className="muted">verification view</span>
        </div>
        <Verify id={verifyId} />
      </div>
    );
  }

  return (
    <div className="column">
      <div className="topbar">
        <div className="brand">
          Suho<span className="hanja">수호</span>
        </div>
        <nav className="nav">
          <button className={screen === "upgrade" ? "active" : ""} onClick={() => setScreen("upgrade")}>
            Upgrade
          </button>
          <button className={screen === "send" ? "active" : ""} onClick={() => setScreen("send")}>
            Send
          </button>
          <button
            className={screen === "directory" ? "active" : ""}
            onClick={() => setScreen("directory")}
          >
            Directory
          </button>
          <button className={screen === "card" ? "active" : ""} onClick={() => setScreen("card")}>
            Card
          </button>
          <button className={screen === "arise" ? "active" : ""} onClick={() => setScreen("arise")}>
            Arise
          </button>
        </nav>
      </div>

      {!status && !error && (
        <div className="status-line">
          <Spinner /> connecting to guardian…
        </div>
      )}
      {error && <div className="errbox">guardian unreachable: {error}</div>}
      {status && screen === "upgrade" && <Upgrade status={status} onDone={() => setScreen("send")} />}
      {status && screen === "send" && (
        <Send status={status} refresh={refresh} prefillRecipient={prefillRecipient} />
      )}
      {status && screen === "directory" && (
        <Directory
          onSendTo={(name) => {
            setPrefillRecipient(name);
            setScreen("send");
          }}
        />
      )}
      {status && screen === "card" && <Card status={status} />}
      {status && screen === "arise" && <Arise status={status} refresh={refresh} />}
    </div>
  );
}
