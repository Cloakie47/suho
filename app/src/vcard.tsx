import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { CardVersion } from "./api";
import { EXPLORER } from "./config";
import { Seal } from "./ui";

const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

/** The virtual card itself (C4) — shared by the Card screen and the read-only
 *  verify view. The QR encodes the account's explorer URL for now (upgrade
 *  path: our own /verify route). */
export function VCard({
  card,
  address,
  upId,
  verified,
}: {
  card: CardVersion;
  address: string;
  upId: string | null;
  verified: boolean;
}) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(`${EXPLORER}/address/${address}`, {
      margin: 1,
      width: 96,
      color: { dark: "#ede7e0", light: "#26221f" },
    }).then(setQr, () => setQr(null));
  }, [address]);

  return (
    <div className="vcard">
      <div className="vcard-head">
        {verified && <Seal />}
        <div>
          <div className="vcard-name">{card.displayName || "—"}</div>
          {upId && <div className="vcard-upid">{upId}.up.id</div>}
        </div>
        {qr && <img className="vcard-qr" src={qr} alt="QR: explorer link" />}
      </div>
      <div className="vcard-fields">
        <div>
          <span className="vcard-label">contact</span> {card.contact || "—"}
        </div>
        <div>
          <span className="vcard-label">remarks</span> {card.remarks || "—"}
        </div>
      </div>
      <div className="vcard-meta">
        v{card.version} · updated {fmtDate(card.time)} ·{" "}
        <a href={`${EXPLORER}/tx/${card.uid}`} onClick={(e) => e.preventDefault()} className="mono">
          {card.uid.slice(0, 10)}…
        </a>
      </div>
      {/* C6 — the honesty line, on the card itself, always. */}
      <div className="vcard-honesty">
        Identity verified by Dojang. Card details are self-declared by the verified owner.
      </div>
    </div>
  );
}

export function CardHistory({ history }: { history: CardVersion[] }) {
  return (
    <div className="card">
      <h2>Version history</h2>
      {history.map((v) => (
        <div className="dir-row" key={v.uid}>
          <div className="dir-name">
            v{v.version} <span className="muted">· {v.displayName}</span>
          </div>
          <div className="muted" style={{ fontSize: "0.8rem", textAlign: "right" }}>
            attested {fmtDate(v.time)}
            <br />
            {v.revocationTime === 0 ? (
              <span className="okbox">current</span>
            ) : (
              <span>revoked {fmtDate(v.revocationTime)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
