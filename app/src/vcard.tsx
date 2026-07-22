import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { CardVersion } from "./api";
import { EXPLORER } from "./config";
import { Seal } from "./ui";

const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The Suho Card at credit-card proportion, L2 treatment, gentle hover tilt
 *  (R5 — shared visual language with the landing hero). */
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
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    QRCode.toDataURL(`${EXPLORER}/address/${address}`, {
      margin: 1,
      width: 152,
      color: { dark: "#1b1917", light: "#ffffff" },
    }).then(setQr, () => setQr(null));
  }, [address]);

  useEffect(() => {
    const stage = stageRef.current;
    const el = cardRef.current;
    if (!stage || !el || reducedMotion() || !matchMedia("(pointer: fine)").matches) return;
    const move = (e: MouseEvent) => {
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `rotateY(${(x * 12).toFixed(2)}deg) rotateX(${(-y * 12).toFixed(2)}deg)`;
    };
    const leave = () => {
      el.style.transform = "";
    };
    stage.addEventListener("mousemove", move);
    stage.addEventListener("mouseleave", leave);
    return () => {
      stage.removeEventListener("mousemove", move);
      stage.removeEventListener("mouseleave", leave);
    };
  }, []);

  return (
    <div className="vcard-stage" ref={stageRef}>
      <div className="vcard" ref={cardRef}>
        <div className="vcard-head">
          {verified && <Seal />}
          <div>
            <div className="vcard-name">{card.displayName || "–"}</div>
            {upId && <div className="vcard-upid">{upId}.up.id</div>}
          </div>
          {qr && <img className="vcard-qr" src={qr} alt="QR: explorer link" />}
        </div>
        <div className="vcard-fields">
          <div>
            <span className="vcard-label">contact</span> {card.contact || "–"}
          </div>
          <div>
            <span className="vcard-label">remarks</span> {card.remarks || "–"}
          </div>
        </div>
        <div>
          <div className="vcard-meta">
            <span className="ver">v{card.version}</span>
            <span>updated {fmtDate(card.time)}</span>
            <span className="mono">{card.uid.slice(0, 10)}…</span>
          </div>
          {/* C6 — the honesty line, on the card itself, always. */}
          <div className="vcard-honesty">
            Identity verified by Dojang. Card details are self-declared by the verified owner.
          </div>
        </div>
      </div>
    </div>
  );
}

/** History as a timeline rail: seal dot = current, hollow = revoked (R5). */
export function CardHistory({ history }: { history: CardVersion[] }) {
  return (
    <div className="card">
      <h2>Versions</h2>
      <div className="timeline">
        {history.map((v) => (
          <div className="tl-item" key={v.uid}>
            <span className={`tl-dot${v.revocationTime !== 0 ? " hollow" : ""}`} aria-hidden="true" />
            <div className="tl-title">
              v{v.version} · {v.displayName}
            </div>
            <div className="tl-sub">
              attested {fmtDate(v.time)}
              {v.revocationTime !== 0 ? ` · revoked ${fmtDate(v.revocationTime)}` : " · current"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
