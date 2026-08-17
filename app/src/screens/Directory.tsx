import { useEffect, useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { api, type DirEntry } from "../api";
import { requireActiveAccount } from "../config";
import { ErrNote, Seal, Spinner, shortAddr } from "../ui";

/// Directory of verified humans. Trust surface unchanged (only active,
/// Dojang-gated names render); restructured to the table + details rail pattern.
export function Directory({ onSendTo }: { onSendTo: (recipient: string) => void }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [shown, setShown] = useState(0);
  const [error, setError] = useState<unknown>(null);
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
      setError(e);
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
        <h1 className="screen-title">Directory</h1>
      </div>

      <div className="cols">
        <div className="main">
          <div className="card">
            <div className="dir-searchbar">
              <Search size={15} strokeWidth={1.75} />
              <input
                type="text"
                placeholder="Search name or address"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search directory"
              />
              {busy && <Spinner />}
            </div>

            {!entries && !error && (
              <div className="status-line" style={{ padding: "14px 0" }}><Spinner /> loading the registry…</div>
            )}
            {error != null && <ErrNote error={error} />}

            {entries && entries.length > 0 && (
              <table className="tbl" style={{ marginTop: 6 }}>
                <thead>
                  <tr><th>Name</th><th>Address</th><th></th></tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const isSelf = e.address.toLowerCase() === requireActiveAccount().toLowerCase();
                    return (
                      <tr key={e.name}>
                        <td>
                          <div className="rowmain">
                            <Seal small />
                            <span className="rowtitle">
                              {e.name}.up.id{isSelf && <span className="you-marker"> · you</span>}
                            </span>
                          </div>
                        </td>
                        <td className="mono">{shortAddr(e.address)}</td>
                        <td className="act-cell">
                          <button className="ret-btn" onClick={() => onSendTo(e.name)} disabled={isSelf}>Send</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {entries && entries.length === 0 && (
              <div className="muted" style={{ padding: "12px 0" }}>No names match “{q}”.</div>
            )}
          </div>
        </div>

        <div className="rail">
          <div className="card">
            <h3>Verified humans</h3>
            <div className="statrow"><span className="k">Names indexed</span><span className="v">{total > 0 ? total.toLocaleString() : "–"}</span></div>
            <div className="statrow"><span className="k">Showing</span><span className="v">{shown}</span></div>
            <button className="msg-indicator" style={{ marginTop: 12 }} onClick={() => load(q, true)} disabled={busy}>
              <RefreshCw size={13} strokeWidth={1.5} /> Rescan
            </button>
          </div>
          <div className="card">
            <h3>How verification works</h3>
            <p className="explain">
              Every name here belongs to a Dojang-verified human. A name only appears while its owner
              is active on chain.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
