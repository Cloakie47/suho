import { useCallback, useEffect, useState } from "react";
import { api, type Status } from "./api";
import { DEMO_ACCOUNT } from "./config";
import { Spinner } from "./ui";
import { Upgrade } from "./screens/Upgrade";
import { Send } from "./screens/Send";
import { Arise } from "./screens/Arise";
import { Directory } from "./screens/Directory";

type Screen = "upgrade" | "send" | "directory" | "arise";

export default function App() {
  const [screen, setScreen] = useState<Screen>("upgrade");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefillRecipient, setPrefillRecipient] = useState<string | null>(null);

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
      {status && screen === "arise" && <Arise status={status} refresh={refresh} />}
    </div>
  );
}
