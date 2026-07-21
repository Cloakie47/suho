import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, type DirEntry } from "../api";
import { activeAccount } from "../config";
import { Seal, Spinner, shortAddr } from "../ui";

/// D2 under the R5 composition pass: table-like rows, sticky search, count
/// header. Trust surface unchanged — only active, Dojang-gated names render.
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

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => load(q), 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [q]);

  return (
    <div>
      <div className="screen-head">
        <p className="eyebrow">
          <span className="ko" lang="ko">지붕 아래</span> · VERIFIED HUMANS
        </p>
        <div className="dir-head-row">
          <h1 className="screen-title">Directory</h1>
          <span className="dir-count">
            {total > 0 ? `${total.toLocaleString()} verified names` : ""}
          </span>
        </div>
      </div>

      <div className="dir-search">
        <input
          type="text"
          placeholder="Search name or address"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search directory"
        />
      </div>

      {!entries && !error && (
        <div className="status-line">
          <Spinner /> loading the registry…
        </div>
      )}
      {error && <div className="errbox">{error}</div>}

      {entries && (
        <div className="card dir-table">
          <div className="muted" style={{ padding: "12px 0 6px", display: "flex", alignItems: "center" }}>
            {shown} shown{busy && <span>&nbsp;· searching…</span>}
            <button className="dir-refresh" onClick={() => load(q, true)} disabled={busy} title="Rescan the chain and re-check every name">
              <RefreshCw size={12} strokeWidth={1.5} style={{ verticalAlign: "-2px" }} /> refresh
            </button>
          </div>
          {entries.map((e) => {
            const isSelf = e.address.toLowerCase() === activeAccount().toLowerCase();
            return (
              <div className="dir-row" key={e.name}>
                <Seal small />
                <div className="dir-name">
                  {e.name}.up.id
                  {isSelf && <span className="you-marker"> · you</span>}
                </div>
                <div className="dir-addr">{shortAddr(e.address)}</div>
                <button className="dir-send" onClick={() => onSendTo(e.name)} disabled={isSelf}>
                  Send
                </button>
              </div>
            );
          })}
          {entries.length === 0 && (
            <div className="muted" style={{ padding: "10px 0 16px" }}>No names match “{q}”.</div>
          )}
        </div>
      )}
    </div>
  );
}
