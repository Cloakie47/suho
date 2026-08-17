import { useEffect, useState } from "react";
import { api, GuardianError, type CardInfo, type Status } from "../api";
import { buildCardCalls, type CardFields } from "../card";
import { executeWithPasskey } from "../execute";
import { requireActiveAccount } from "../config";
import { Spinner, shortAddr } from "../ui";
import { VCard, CardHistory } from "../vcard";
import { useToast, type TxToast } from "../toast";
import { humanError, isUserCancel } from "../errors";

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
  const [syncing, setSyncing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const toast = useToast();

  // Render the actual card DOM to a PNG the user can save. html2canvas is loaded
  // lazily (kept out of the main bundle). The QR is a data-URL <img>, so it is
  // captured losslessly and stays scannable. The card's inline 3D-tilt transform
  // is neutralized so the export is flat and true to the design.
  const downloadCard = async () => {
    const el = document.querySelector(".vcard") as HTMLElement | null;
    if (!el) return;
    setDownloading(true);
    const prevTransform = el.style.transform;
    try {
      const html2canvas = (await import("html2canvas")).default;
      if (document.fonts?.ready) await document.fonts.ready;
      el.style.transform = "none";
      const canvas = await html2canvas(el, { backgroundColor: null, scale: 2, useCORS: true });
      const slug =
        (info?.current?.displayName || status.upId || "card")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "card";
      const link = document.createElement("a");
      link.download = `suho-card-${slug}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch {
      toast.note("Couldn't render the card image. Try again.");
    } finally {
      el.style.transform = prevTransform;
      setDownloading(false);
    }
  };

  const load = async () => {
    try {
      setInfo(await api.card(requireActiveAccount()));
    } catch (e) {
      setPhase({ k: "error", message: humanError(e).text });
    }
  };
  // After a create/update the tx is only PRECONFIRMED when executeWithPasskey
  // resolves, but the card is read from EAS through the guardian's indexer, which
  // lags a few seconds. Poll until the expected version is queryable so the new
  // card/version appears without a manual refresh; always reflect the latest read.
  const loadUntilVersion = async (targetVersion: number) => {
    for (let i = 0; i < 12; i++) {
      try {
        const fresh = await api.card(requireActiveAccount());
        setInfo(fresh);
        if (fresh.current && (fresh.current.version ?? 0) >= targetVersion) return;
      } catch {
        // transient RPC/indexer hiccup — keep polling
      }
      await new Promise((r) => setTimeout(r, 1000));
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
      setSyncing(true);
      await loadUntilVersion(nextV);
      setSyncing(false);
    } catch (e) {
      if (isUserCancel(e)) {
        h.t?.dismiss();
        setPhase({ k: "idle" });
        toast.note("Canceled.");
      } else if (h.t) {
        h.t.error(e);
        setPhase({ k: "idle" });
      } else {
        setPhase({ k: "error", message: humanError(e).text });
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
          {status.upId ? `${status.upId}.up.id` : shortAddr(requireActiveAccount())}&rsquo;s card
        </p>
      </div>

      {!info ? (
        <div className="status-line">
          <Spinner /> loading card…
        </div>
      ) : (
        <div className="cols">
          <div className="main">
            {info.current ? (
              <>
                <VCard
                  card={info.current}
                  address={requireActiveAccount()}
                  upId={status.upId}
                  verified={status.isVerified}
                />
                {!editing && (
                  <div className="card hover" style={{ marginTop: 16 }}>
                    <button className="primary wide" style={{ marginTop: 0 }} onClick={startEdit}>
                      Edit card
                    </button>
                    <button
                      className="secondary wide"
                      style={{ marginTop: 10 }}
                      onClick={downloadCard}
                      disabled={downloading}
                    >
                      {downloading ? "Rendering…" : "Download card"}
                    </button>
                    <div className="muted" style={{ marginTop: 10, fontSize: "0.8rem" }}>
                      Share the read-only view:{" "}
                      <a href={`#/verify/${requireActiveAccount()}`} target="_blank">
                        /verify/{shortAddr(requireActiveAccount())}
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
            {syncing && (
              <div className="status-line">
                <Spinner /> Syncing the new version…
              </div>
            )}
            {phase.k === "error" && <div className="errbox">{phase.message}</div>}
          </div>

          <div className="rail">
            {info.history.length > 0 ? (
              <CardHistory history={info.history} />
            ) : (
              <div className="card">
                <h3>Versions</h3>
                <p className="explain">
                  Every edit becomes a new attested version; the refUID chain is the history. Nothing
                  is ever deleted.
                </p>
              </div>
            )}
            <div className="card">
              <h3>How the card works</h3>
              <p className="explain">
                Your passkey signs each version onto EAS; the seal attests the human, the fields are
                your own claims. Anyone can verify the read-only view without a wallet.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
