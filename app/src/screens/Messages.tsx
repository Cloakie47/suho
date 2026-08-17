import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { ChevronDown, ExternalLink, TriangleAlert, Undo2, X } from "lucide-react";
import {
  loadThreads,
  sentRequestsByTx,
  activeInboxRequests,
  markReturned,
  respondToMessage,
  requestReturn,
  sanitizeBody,
  REQUEST_MAX,
  type Threads,
} from "../messages";
import type { TxMessageWire } from "../api";
import type { Call } from "../chain";
import { executeWithPasskey } from "../execute";
import { requireActiveAccount, EXPLORER } from "../config";
import { humanError, isUserCancel } from "../errors";
import { useToast } from "../toast";
import { fmtEth, shortAddr } from "../ui";

/// Phase M revision. Return-request reads are PUBLIC (viewable by address), so the
/// inbox loads with no unlock. Only receiver actions prompt a passkey — and even
/// then only decline/dismiss/block (Return funds is a normal send; mark-returned
/// is on-chain verified). Memos are no longer here — they are on-chain events
/// rendered inline on activity rows.

const erc20Abi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

export interface MessagesState {
  loading: boolean;
  error: string | null;
  sentRequests: Map<string, TxMessageWire>;
  activeRequests: TxMessageWire[];
  reload: () => Promise<void>;
}

export function useMessages(account: Hex | null, bump: number): MessagesState {
  const [threads, setThreads] = useState<Threads | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    setError(null);
    try {
      setThreads(await loadThreads(account));
    } catch (e) {
      setError(humanError(e).text);
    } finally {
      setLoading(false);
    }
  }, [account]);

  // Public reads: load on mount and after sends (bump). No passkey to view.
  useEffect(() => {
    if (account) void reload();
  }, [account, bump, reload]);

  return {
    loading,
    error,
    sentRequests: threads ? sentRequestsByTx(threads) : new Map(),
    activeRequests: threads ? activeInboxRequests(threads) : [],
    reload,
  };
}

function amountLabel(m: TxMessageWire): string {
  if (m.token === "ETH") return `${fmtEth(BigInt(m.amountWei), 4)} ETH`;
  return `${m.amountWei} @ ${shortAddr(m.token)}`;
}

function chipLabel(m: TxMessageWire): string {
  if (m.status === "returned") return "Returned";
  if (m.status === "declined") return "Return declined";
  return m.kind === "reminder" ? "Return reminded" : "Return requested";
}

/** Row-level control for an outgoing transfer: the status chip if a request
 *  already exists, else a "Request return" action when eligible, else a one-line
 *  reason. `onOpen` opens the request modal for this tx. */
export function RowRequestAction({
  amountWei,
  isOutgoing,
  verified,
  existing,
  onOpen,
}: {
  amountWei?: bigint;
  isOutgoing: boolean;
  verified: boolean;
  existing?: TxMessageWire;
  onOpen: () => void;
}) {
  if (!isOutgoing || amountWei === undefined) return null;
  if (existing) return <span className={`ret-chip ${existing.status}`}>{chipLabel(existing)}</span>;
  if (!verified) return <span className="ret-na">Verify to request returns</span>;
  return (
    <button className="ret-btn" onClick={onOpen}>
      Request return
    </button>
  );
}

/** The requests inbox surface: received active return requests with actions. */
export function RequestsInbox({ msg }: { msg: MessagesState }) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const toast = useToast();
  const active = msg.activeRequests;
  // Expand the first request by default; collapsed items show a one-line snippet
  // so a long message never crowds the actions.
  const open = openId ?? active[0]?.id ?? null;
  if (active.length === 0) return null;

  const returnFunds = async (m: TxMessageWire) => {
    setBusyId(m.id);
    const handle = toast.begin(`Returning ${amountLabel(m)} to ${shortAddr(m.from)}…`);
    try {
      const calls: Call[] =
        m.token === "ETH"
          ? [{ target: m.from, value: BigInt(m.amountWei), data: "0x" }]
          : [
              {
                target: m.token as Hex,
                value: 0n,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "transfer",
                  args: [m.from, BigInt(m.amountWei)],
                }),
              },
            ];
      const { txHash } = await executeWithPasskey(calls, "", {
        preconf: (ms) => handle.preconfirmed("Returned", ms),
        final: (h) => handle.final(h),
        reverted: () => handle.error(new Error("TransactionReverted")),
      });
      // Public, on-chain-verified — no extra passkey.
      await markReturned(m.id, txHash);
      await msg.reload();
    } catch (e) {
      if (isUserCancel(e)) handle.dismiss();
      else handle.error(e);
    } finally {
      setBusyId(null);
    }
  };

  const respond = async (m: TxMessageWire, action: "decline" | "dismiss" | "block") => {
    setBusyId(m.id);
    try {
      await respondToMessage(requireActiveAccount(), m.id, action);
      await msg.reload();
    } catch (e) {
      if (!isUserCancel(e)) toast.note(humanError(e).text);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card reqbox">
      <h3>
        Return requests <span className="req-count">{active.length}</span>
      </h3>
      {active.map((m) => {
        const isOpen = open === m.id;
        return (
          <div className={`req-item${isOpen ? " open" : ""}`} key={m.id}>
            <button className="req-head" onClick={() => setOpenId(isOpen ? -1 : m.id)}>
              <TriangleAlert size={15} color="var(--warn)" strokeWidth={1.5} style={{ flex: "none", marginTop: 2 }} />
              <span className="req-line"><b>{amountLabel(m)}</b> from {shortAddr(m.from)}</span>
              <ChevronDown className="req-caret" size={15} strokeWidth={1.75} />
            </button>
            {!isOpen && m.body && <div className="req-snippet">"{m.body}"</div>}
            {isOpen && (
              <div className="req-detail">
                {m.body && <div className="req-body">"{m.body}"</div>}
                <a className="req-txlink" href={`${EXPLORER}/tx/${m.txHash}`} target="_blank" rel="noreferrer">
                  {shortAddr(m.txHash)} <ExternalLink size={11} strokeWidth={1.5} />
                </a>
                <div className="req-actions">
                  <button className="primary sm" disabled={busyId === m.id} onClick={() => void returnFunds(m)}>
                    <Undo2 size={13} strokeWidth={1.5} /> Return funds
                  </button>
                  <button className="secondary sm" disabled={busyId === m.id} onClick={() => void respond(m, "decline")}>
                    Decline
                  </button>
                  <button className="ghost sm" disabled={busyId === m.id} onClick={() => void respond(m, "dismiss")}>
                    Dismiss
                  </button>
                  <button
                    className="ghost sm danger"
                    disabled={busyId === m.id}
                    onClick={() => void respond(m, "block")}
                    title="Block this requester"
                  >
                    <X size={13} strokeWidth={1.5} /> Block
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The return-request modal (M3): read-only tx facts + one message field + the
 *  honest limits copy. Submit signs a content-bound passkey assertion and posts. */
export function RequestReturnModal({
  txHash,
  recipient,
  amountWei,
  onDone,
  onClose,
}: {
  txHash: Hex;
  recipient: Hex;
  amountWei: bigint;
  onDone: () => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  const submit = async () => {
    const clean = sanitizeBody(body);
    if (!clean) {
      setErr("Add a short message so they know which transfer you mean.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await requestReturn(requireActiveAccount(), txHash, clean);
      toast.note("Return requested.");
      onDone();
      onClose();
    } catch (e) {
      if (isUserCancel(e)) {
        setBusy(false);
        return;
      }
      setErr(humanError(e).text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Request a return">
      <div className="l2 confirm-modal">
        <h2 style={{ margin: 0 }}>Request a return</h2>
        <div className="ret-facts">
          <div>
            <span className="muted">To</span> {shortAddr(recipient)}
          </div>
          <div>
            <span className="muted">Amount</span> {fmtEth(amountWei, 4)} ETH
          </div>
          <div>
            <span className="muted">Transfer</span>{" "}
            <a href={`${EXPLORER}/tx/${txHash}`} target="_blank" rel="noreferrer">
              {shortAddr(txHash)}
            </a>
          </div>
        </div>
        <p className="muted" style={{ margin: "10px 0 0" }}>
          This asks the recipient to send the funds back. They choose whether to. Suho cannot reverse a
          transaction.
        </p>
        <input
          type="text"
          className="memo-input"
          placeholder="Add a message (e.g. sent by mistake)"
          value={body}
          maxLength={REQUEST_MAX}
          onChange={(e) => setBody(e.target.value)}
          style={{ marginTop: 12 }}
          aria-label="Message to the recipient"
        />
        {err && <div className="errbox" style={{ marginTop: 8 }}>{err}</div>}
        <button className="primary wide" disabled={busy} onClick={() => void submit()} style={{ marginTop: 14 }}>
          {busy ? "Sending request…" : "Send return request"}
        </button>
        <button className="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
