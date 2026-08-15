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
  Timer,
  TriangleAlert,
  Users,
  Zap,
} from "lucide-react";
import { api, type Status } from "../api";
import { fetchActivity, type ActivityItem } from "../activity";
import { useMessages, RequestsInbox, RowRequestAction, RequestReturnModal } from "./Messages";
import { Seal, fmtEth, shortAddr } from "../ui";
import { sessionStats, measuredMs } from "../stats";

const icon = { size: 14, strokeWidth: 1.5 } as const;
const PAGE = 10;

function StatCards({ verifiedNames }: { verifiedNames: number | null }) {
  const { sends, avgMs } = sessionStats();
  return (
    <div className="stat-grid">
      <div className="stat-card">
        <div className="stat-label">
          Sends this session <Zap {...icon} />
        </div>
        <div className="stat-value">{sends}</div>
        <div className="stat-sub">passkey-signed</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          Avg preconfirmation <Timer {...icon} />
        </div>
        <div className="stat-value jade">{avgMs === null ? "–" : `${(avgMs / 1000).toFixed(1)}s`}</div>
        <div className="stat-sub">flashblocks, measured live</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          Verified recipients <Users {...icon} />
        </div>
        <div className="stat-value">{verifiedNames === null ? "–" : verifiedNames.toLocaleString()}</div>
        <div className="stat-sub">active up.id names</div>
      </div>
    </div>
  );
}

function ActivityIcon({ item }: { item: ActivityItem }) {
  if (item.kind === "send" && item.verified) return <Seal small />;
  const cls =
    item.kind === "send" || item.kind === "transfer"
      ? "act-icon amber"
      : item.kind === "received"
        ? "act-icon jade"
        : "act-icon seal-c";
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

export function Activity({ status }: { status: Status }) {
  const account = status.address;
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(0);
  const [bump, setBump] = useState(0);
  const [verifiedNames, setVerifiedNames] = useState<number | null>(null);
  const [requestFor, setRequestFor] = useState<ActivityItem | null>(null);
  const msg = useMessages(account, bump);

  const load = useCallback(async (force = false) => {
    try {
      const v = await fetchActivity(force);
      setItems(v);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, bump]);

  useEffect(() => {
    api.directory("").then(
      (r) => setVerifiedNames(r.total),
      () => setVerifiedNames(null),
    );
  }, []);

  const refreshAll = () => {
    setBump((b) => b + 1); // reloads activity + messages
  };

  const pages = items ? Math.max(1, Math.ceil(items.length / PAGE)) : 1;
  const clampedPage = Math.min(page, pages - 1);
  const pageItems = items ? items.slice(clampedPage * PAGE, clampedPage * PAGE + PAGE) : null;

  return (
    <div>
      <div className="screen-head">
        <p className="eyebrow">HISTORY, NOTES &amp; REQUESTS</p>
        <h1 className="screen-title">Activity</h1>
      </div>

      <StatCards verifiedNames={verifiedNames} />

      {/* M4: received return requests with actions */}
      <RequestsInbox msg={msg} />
      {msg.error && <div className="muted" style={{ padding: "0 0 10px" }}>{msg.error}</div>}

      <div className="card activity">
        <div className="activity-head">
          <h2>Transactions</h2>
          <button className="msg-indicator" onClick={refreshAll} title="Refresh">
            <RefreshCw size={13} strokeWidth={1.5} /> Refresh
          </button>
        </div>

        {failed && <div className="muted" style={{ padding: "8px 0 16px" }}>Explorer unreachable. Activity hidden.</div>}
        {!items && !failed && (
          <div style={{ padding: "8px 0 16px", display: "grid", gap: 14 }}>
            {[80, 60, 70].map((w, i) => (
              <div key={i} className="skeleton" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {items && items.length === 0 && (
          <div className="muted" style={{ padding: "8px 0 16px" }}>
            No transactions yet.
          </div>
        )}

        {pageItems?.map((it) => {
          const ms = measuredMs(it.hash);
          const isOutgoing = (it.kind === "send" || it.kind === "transfer") && !!it.counterparty;
          return (
            <div key={it.hash}>
              <div className="act-row">
                <ActivityIcon item={it} />
                <div className="act-main">
                  <div className="act-title">{it.title}</div>
                  <div className="act-sub">
                    {it.counterparty ? `${shortAddr(it.counterparty)} · ` : ""}
                    {new Date(it.timestamp).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
                <div className="act-right">
                  {it.amountWei !== undefined && <div className="act-amt">{fmtEth(it.amountWei, 4)} ETH</div>}
                  {ms !== undefined && <div className="act-ms">{(ms / 1000).toFixed(1)}s</div>}
                </div>
                <a className="act-link" href={it.explorer} target="_blank" rel="noreferrer" aria-label="View on explorer">
                  <ExternalLink size={14} strokeWidth={1.5} />
                </a>
              </div>
              {/* M2: on-chain memo attached to this transfer (public). */}
              {it.memo && <div className="act-memo">"{it.memo}"</div>}
              {/* M3: return-request control on outgoing transfers. */}
              <div className="act-actions">
                <RowRequestAction
                  amountWei={it.amountWei}
                  isOutgoing={isOutgoing}
                  verified={status.isVerified}
                  existing={msg.sentRequests.get(it.hash.toLowerCase())}
                  onOpen={() => setRequestFor(it)}
                />
              </div>
            </div>
          );
        })}

        {items && items.length > PAGE && (
          <div className="pager">
            <button className="ghost sm" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>
              Prev
            </button>
            <span className="pager-label">
              Page {clampedPage + 1} of {pages}
            </span>
            <button className="ghost sm" disabled={clampedPage >= pages - 1} onClick={() => setPage(clampedPage + 1)}>
              Next
            </button>
          </div>
        )}
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
