import { useEffect, useState } from "react";
import { api, GuardianError, type CardInfo, type Status } from "../api";
import { buildCardCalls, type CardFields } from "../card";
import { executeWithPasskey } from "../execute";
import { activeAccount } from "../config";
import { Spinner, shortAddr } from "../ui";
import { VCard, CardHistory } from "../vcard";
import { useToast, type TxToast } from "../toast";

// The lifecycle toast is the tx surface; inline phases cover the passkey
// prompt and pre-relay errors only.
type Phase =
  | { k: "idle" }
  | { k: "signing" }
  | { k: "error"; message: string };

export function Card({ status }: { status: Status }) {
  const [info, setInfo] = useState<CardInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<CardFields>({ displayName: "", contact: "", remarks: "" });
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const toast = useToast();

  const load = async () => {
    try {
      setInfo(await api.card(activeAccount()));
    } catch (e) {
      setPhase({ k: "error", message: String(e) });
    }
  };
  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    const creating = !info?.current;
    const nextV = (info?.current?.version ?? 0) + 1;
    // Assigned inside executeWithPasskey's `sent` hook (object property so the
    // narrowing survives the closure).
    const h: { t: TxToast | null } = { t: null };
    try {
      setPhase({ k: "signing" });
      const calls = buildCardCalls(fields, info?.current?.uid ?? null);
      await executeWithPasskey(calls, "", {
        // Button said "Sign & create"/"Sign & update"; toast continues the verb.
        sent: () => {
          h.t = toast.begin(creating ? "Creating your card…" : "Updating card…");
        },
        preconf: (ms) => h.t?.preconfirmed(creating ? "Card v1 created" : `Updated to v${nextV}`, ms),
        final: (hash) => h.t?.final(hash),
        reverted: () => h.t?.error(new Error("TransactionReverted")),
      });
      setPhase({ k: "idle" });
      setEditing(false);
      await load();
    } catch (e) {
      if (h.t) {
        h.t.error(e);
        setPhase({ k: "idle" });
      } else {
        setPhase({ k: "error", message: e instanceof GuardianError ? e.message : String(e) });
      }
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

  return (
    <div>
      <div className="screen-head">
        <p className="eyebrow">ATTESTED IDENTITY</p>
        <h1 className="screen-title">Suho Card</h1>
        <p className="muted" style={{ margin: "6px 0 0" }}>
          {status.upId ? `${status.upId}.up.id` : shortAddr(activeAccount())}&rsquo;s card
        </p>
      </div>

      {!info ? (
        <div className="status-line">
          <Spinner /> loading card…
        </div>
      ) : (
        <div className="card-layout">
          <div>
            {info.current ? (
              <>
                <VCard
                  card={info.current}
                  address={activeAccount()}
                  upId={status.upId}
                  verified={status.isVerified}
                />
                {!editing && (
                  <div className="card hover" style={{ marginTop: 16 }}>
                    <button className="primary wide" style={{ marginTop: 0 }} onClick={startEdit}>
                      Edit card
                    </button>
                    <div className="muted" style={{ marginTop: 10, fontSize: "0.8rem" }}>
                      Share the read-only view:{" "}
                      <a href={`#/verify/${activeAccount()}`} target="_blank">
                        /verify/{shortAddr(activeAccount())}
                      </a>
                    </div>
                  </div>
                )}
              </>
            ) : (
              !editing && (
                <div className="card center">
                  <div className="hero">Your Suho Card</div>
                  <p className="muted">
                    An attested identity card, signed by your passkey and living on EAS. The seal
                    attests the human; the fields are your claims.
                  </p>
                  <button className="primary wide" onClick={startEdit}>
                    Create your card
                  </button>
                </div>
              )
            )}

            {editing && (
              <div className="card" style={{ marginTop: info.current ? 16 : 0 }}>
                <h2>
                  {info.current
                    ? `Edit card (creates v${(info.current.version ?? 0) + 1})`
                    : "Create your card (v1)"}
                </h2>
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
                    One passkey signature attests the new version and revokes v
                    {info.current.version}. Nothing is deleted.
                  </div>
                )}
                <button
                  className="primary wide"
                  disabled={!fields.displayName || phase.k === "signing"}
                  onClick={submit}
                >
                  {info.current ? "Sign & update" : "Sign & create"}
                </button>
                <button className="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            )}

            {phase.k === "signing" && (
              <div className="status-line">
                <Spinner /> Confirm with your passkey…
              </div>
            )}
            {phase.k === "error" && <div className="errbox">{phase.message}</div>}
          </div>

          <div>
            {info.history.length > 0 ? (
              <CardHistory history={info.history} />
            ) : (
              <div className="card">
                <h2>Versions</h2>
                <p className="muted">
                  Every edit becomes a new attested version; the refUID chain is the history. Nothing
                  is ever deleted.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
