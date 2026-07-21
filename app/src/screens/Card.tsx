import { useEffect, useState } from "react";
import { api, GuardianError, type CardInfo, type Status } from "../api";
import { buildCardCalls, type CardFields } from "../card";
import { executeWithPasskey } from "../execute";
import { DEMO_ACCOUNT, EXPLORER } from "../config";
import { Spinner, TileDivider, shortAddr } from "../ui";
import { VCard, CardHistory } from "../vcard";

type Phase =
  | { k: "idle" }
  | { k: "signing" }
  | { k: "confirming" }
  | { k: "done"; txHash: string; ms: number }
  | { k: "error"; message: string };

export function Card({ status }: { status: Status }) {
  const [info, setInfo] = useState<CardInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [fields, setFields] = useState<CardFields>({ displayName: "", contact: "", remarks: "" });
  const [phase, setPhase] = useState<Phase>({ k: "idle" });

  const load = async () => {
    try {
      setInfo(await api.card(DEMO_ACCOUNT));
    } catch (e) {
      setPhase({ k: "error", message: String(e) });
    }
  };
  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    try {
      setPhase({ k: "signing" });
      const calls = buildCardCalls(fields, info?.current?.uid ?? null);
      setPhase({ k: "confirming" });
      const { txHash, preconfMs } = await executeWithPasskey(calls);
      setPhase({ k: "done", txHash, ms: preconfMs });
      setEditing(false);
      await load();
    } catch (e) {
      setPhase({ k: "error", message: e instanceof GuardianError ? e.message : String(e) });
    }
  };

  const startEdit = () => {
    const c = info?.current;
    setFields({
      displayName: c?.displayName ?? "",
      contact: c?.contact ?? "",
      remarks: c?.remarks ?? "",
    });
    setPhase({ k: "idle" });
    setEditing(true);
  };

  if (!info) {
    return (
      <div className="status-line">
        <Spinner /> loading card…
      </div>
    );
  }

  return (
    <div>
      {info.current && !editing && (
        <>
          <VCard
            card={info.current}
            address={DEMO_ACCOUNT}
            upId={status.upId}
            verified={status.isVerified}
          />
          <div className="card center">
            <button className="primary" onClick={startEdit}>
              Edit card
            </button>
            <button className="secondary" onClick={() => setShowHistory((s) => !s)}>
              {showHistory ? "Hide history" : `History (${info.history.length} version${info.history.length > 1 ? "s" : ""})`}
            </button>
            <div className="muted" style={{ marginTop: 10, fontSize: "0.8rem" }}>
              Share the read-only view:{" "}
              <a href={`#/verify/${DEMO_ACCOUNT}`} target="_blank">
                /verify/{shortAddr(DEMO_ACCOUNT)}
              </a>
            </div>
          </div>
          {showHistory && <CardHistory history={info.history} />}
        </>
      )}

      {!info.current && !editing && (
        <div className="card center">
          <div className="hero">Your Suho Card</div>
          <p className="muted">
            An attested identity card, signed by your passkey and living on EAS. The seal attests
            the human; the fields are your claims.
          </p>
          <button className="primary" onClick={startEdit}>
            Create your card
          </button>
        </div>
      )}

      {editing && (
        <div className="card">
          <h2>{info.current ? `Edit card (creates v${(info.current.version ?? 0) + 1})` : "Create your card (v1)"}</h2>
          <div style={{ display: "grid", gap: 10 }}>
            <input
              type="text"
              placeholder="Display name"
              value={fields.displayName}
              onChange={(e) => setFields({ ...fields, displayName: e.target.value })}
            />
            <input
              type="text"
              placeholder="Contact (e.g. @handle or email)"
              value={fields.contact}
              onChange={(e) => setFields({ ...fields, contact: e.target.value })}
            />
            <input
              type="text"
              placeholder="Remarks"
              value={fields.remarks}
              onChange={(e) => setFields({ ...fields, remarks: e.target.value })}
            />
          </div>
          {info.current && (
            <div className="muted" style={{ marginTop: 8, fontSize: "0.8rem" }}>
              One passkey signature attests the new version and revokes v{info.current.version}{" "}
              atomically. Nothing is deleted — the history stays walkable.
            </div>
          )}
          <button
            className="primary"
            disabled={!fields.displayName || phase.k === "signing" || phase.k === "confirming"}
            onClick={submit}
          >
            {info.current ? "Sign & update" : "Sign & create"}
          </button>
          <button className="secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      )}

      <TileDivider />

      {phase.k === "signing" && (
        <div className="status-line">
          <Spinner /> Confirm with your passkey…
        </div>
      )}
      {phase.k === "confirming" && (
        <div className="status-line">
          <Spinner /> Attesting on GIWA…
        </div>
      )}
      {phase.k === "done" && (
        <div className="okbox">
          ✓ Card attested in <span className="timing">{phase.ms}ms</span> ·{" "}
          <a href={`${EXPLORER}/tx/${phase.txHash}`} target="_blank">
            explorer
          </a>
        </div>
      )}
      {phase.k === "error" && <div className="errbox">{phase.message}</div>}
    </div>
  );
}
