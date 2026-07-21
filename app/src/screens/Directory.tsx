import { useEffect, useRef, useState } from "react";
import { api, type DirEntry } from "../api";
import { DEMO_ACCOUNT } from "../config";
import { Seal, Spinner, TileDivider, shortAddr } from "../ui";

/// D2: the directory IS the trust surface — only active, Dojang-gated names can
/// appear (guardian enforces it by construction; nothing unverified renders).
/// Search is server-side: the in-window registry holds tens of thousands of
/// names, so the guardian filters and caps at 500 rows per query.
export function Directory({ onSendTo }: { onSendTo: (recipient: string) => void }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [shown, setShown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef<number>();

  const load = async (query: string, refresh = false) => {
    setBusy(true);
    try {
      const r = await api.directory(query, refresh);
      setEntries(r.entries);
      setTotal(r.total);
      setShown(r.shown);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load("");
  }, []);

  // 300ms debounce, same rhythm as the Send screen's resolver.
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => load(q), 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [q]);

  return (
    <div>
      <div className="card">
        <h2>Directory</h2>
        <p className="muted">
          Every entry is a verified human with an active up.id — unverified addresses cannot appear
          here.
        </p>
        <input
          type="text"
          placeholder="Search name or address"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <TileDivider />

      {!entries && !error && (
        <div className="status-line">
          <Spinner /> loading the registry…
        </div>
      )}
      {error && <div className="errbox">{error}</div>}

      {entries && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>
            {shown} shown · {total} verified names in the demo era
            {busy && <span> · searching…</span>}
            <button
              className="dir-refresh"
              onClick={() => load(q, true)}
              disabled={busy}
              title="Rescan the chain and re-check every name against the live registry"
            >
              refresh
            </button>
          </div>
          {entries.map((e) => {
            const isSelf = e.address.toLowerCase() === DEMO_ACCOUNT.toLowerCase();
            return (
              <div className="dir-row" key={e.name}>
                <Seal small />
                <div className="dir-name">
                  {e.name}.up.id
                  {isSelf && <span className="you-marker"> · you</span>}
                </div>
                <div className="muted mono">{shortAddr(e.address)}</div>
                <button className="dir-send" onClick={() => onSendTo(e.name)} disabled={isSelf}>
                  Send
                </button>
              </div>
            );
          })}
          {entries.length === 0 && <div className="muted">No names match “{q}”.</div>}
        </div>
      )}
    </div>
  );
}
