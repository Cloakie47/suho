import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ExternalLink,
  IdCard,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { type Status } from "../api";
import { fetchActivity, type ActivityItem } from "../activity";
import { useMessages, RequestsInbox, RowRequestAction, RequestReturnModal } from "./Messages";
import { Seal, fmtEth, shortAddr } from "../ui";
import { measuredMs } from "../stats";

const PAGE = 10;

function ActivityIcon({ item }: { item: ActivityItem }) {
  if (item.kind === "send" && item.verified) return <Seal small />;
  const cls =
    item.kind === "send" || item.kind === "transfer"
      ? "ic-badge amber"
      : item.kind === "received"
        ? "ic-badge jade"
        : "ic-badge";
  const I =
    item.kind === "arise"
      ? KeyRound
      : item.kind === "card"
        ? IdCard
        : item.kind === "upgrade"
          ? ShieldCheck
          : item.kind === "received"
            ? ArrowDownLeft
            : item.kind === "transfer"
              ? ArrowUpRight
              : TriangleAlert;
  return (
    <span className={cls}>
      <I size={16} strokeWidth={1.5} />
    </span>
  );
}

const typeLabel = (it: ActivityItem): string =>
  it.kind === "send" || it.kind === "transfer"
    ? "Sent"
    : it.kind === "received"
      ? "Received"
      : it.kind === "card"
        ? "Card attested"
        : it.kind === "upgrade"
          ? "Upgraded"
          : it.kind === "arise"
            ? "Arise"
            : "Activity";

function counterparty(it: ActivityItem): string {
  if (it.kind === "card") return "via passkey";
  if (it.kind === "upgrade" || it.kind === "arise") return "self";
  if (it.counterpartyName) return `${it.counterpartyName}.up.id`;
  if (it.counterparty) return `${shortAddr(it.counterparty)}${it.kind !== "received" && !it.verified ? " · unverified" : ""}`;
  return "";
}

export function Activity({ status }: { status: Status }) {
  const account = status.address;
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(0);
  const [bump, setBump] = useState(0);
  const [requestFor, setRequestFor] = useState<ActivityItem | null>(null);
  const msg = useMessages(account, bump);

  const load = useCallback(async (force = false) => {
    try {
      setItems(await fetchActivity(force));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, bump]);

  const refreshAll = () => setBump((b) => b + 1);

  const pages = items ? Math.max(1, Math.ceil(items.length / PAGE)) : 1;
  const clampedPage = Math.min(page, pages - 1);
  const pageItems = items ? items.slice(clampedPage * PAGE, clampedPage * PAGE + PAGE) : null;

  return (
    <div>
      <div className="screen-head act-screen-head">
        <div>
          <p className="eyebrow">HISTORY, NOTES &amp; REQUESTS</p>
          <h1 className="screen-title">Activity</h1>
        </div>
        <button className="msg-indicator" onClick={refreshAll} title="Refresh">
          <RefreshCw size={13} strokeWidth={1.5} /> Refresh
        </button>
      </div>

      <div className="cols">
        {/* MAIN: transactions table */}
        <div className="main">
          <div className="card">
            <h2>Transactions</h2>
            {failed && <div className="muted" style={{ padding: "8px 0" }}>Explorer unreachable. Activity hidden.</div>}
            {!items && !failed && (
              <div style={{ padding: "8px 0", display: "grid", gap: 14 }}>
                {[80, 60, 70].map((w, i) => (
                  <div key={i} className="skeleton" style={{ width: `${w}%` }} />
                ))}
              </div>
            )}
            {items && items.length === 0 && <div className="muted" style={{ padding: "8px 0" }}>No transactions yet.</div>}

            {pageItems && pageItems.length > 0 && (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Counterparty</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                    <th>When</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((it) => {
                    const ms = measuredMs(it.hash);
                    const isOutgoing = (it.kind === "send" || it.kind === "transfer") && !!it.counterparty;
                    return (
                      <tr key={it.hash}>
                        <td>
                          <div className="rowmain">
                            <ActivityIcon item={it} />
                            <span className="rowtitle">{typeLabel(it)}</span>
                          </div>
                          {it.memo && <div className="act-memo">"{it.memo}"</div>}
                        </td>
                        <td className="mono">{counterparty(it)}</td>
                        <td className="amt">
                          {it.amountWei !== undefined ? `${fmtEth(it.amountWei, 4)} ETH` : ""}
                          {ms !== undefined && <span className="ms"> {(ms / 1000).toFixed(1)}s</span>}
                        </td>
                        <td className="when">
                          {new Date(it.timestamp).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="act-cell">
                          <RowRequestAction
                            amountWei={it.amountWei}
                            isOutgoing={isOutgoing}
                            verified={status.isVerified}
                            existing={msg.sentRequests.get(it.hash.toLowerCase())}
                            onOpen={() => setRequestFor(it)}
                          />
                          <a className="act-link" href={it.explorer} target="_blank" rel="noreferrer" aria-label="View on explorer">
                            <ExternalLink size={14} strokeWidth={1.5} />
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {items && items.length > PAGE && (
              <div className="pager">
                <button className="ghost sm" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>Prev</button>
                <span className="pager-label">Page {clampedPage + 1} of {pages}</span>
                <button className="ghost sm" disabled={clampedPage >= pages - 1} onClick={() => setPage(clampedPage + 1)}>Next</button>
              </div>
            )}
          </div>
        </div>

        {/* RAIL: requests + explainer */}
        <div className="rail">
          <RequestsInbox msg={msg} />
          {msg.sentRequests.size > 0 && (
            <div className="card">
              <h3>Your requests</h3>
              {[...msg.sentRequests.values()].map((r) => (
                <div className="statrow" key={r.id}>
                  <span className="k">
                    {r.token === "ETH" ? `${fmtEth(BigInt(r.amountWei), 4)} ETH` : r.amountWei} to {shortAddr(r.to)}
                  </span>
                  <span className={`ret-chip ${r.status}`}>
                    {r.status === "returned" ? "Returned" : r.status === "declined" ? "Declined" : "Requested"}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="card">
            <h3>About notes</h3>
            <p className="explain">
              Notes are public and on chain. A return request reaches the real person to ask. Suho cannot
              reverse a transaction.
            </p>
          </div>
        </div>
      </div>

      {requestFor && requestFor.counterparty && requestFor.amountWei !== undefined && (
        <RequestReturnModal
          txHash={requestFor.hash as Hex}
          recipient={requestFor.counterparty}
          amountWei={requestFor.amountWei}
          onDone={refreshAll}
          onClose={() => setRequestFor(null)}
        />
      )}
    </div>
  );
}
