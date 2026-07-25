import { humanError } from "./errors";

/** The dojang-style verified seal — the one flourish that must land. */
export function Seal({ small, large }: { small?: boolean; large?: boolean }) {
  return (
    <span className={`seal${small ? " small" : ""}${large ? " large" : ""}`} title="Dojang-verified">
      수호
    </span>
  );
}

/** Success indicator = the dojang seal, pressed in like a stamp. Success and
 *  "verified" share one visual language: this is the same seal as the verified
 *  recipient mark, larger, with the press-in stamp animation on entry. Replaces
 *  the old placeholder success checkmark. */
export function SealStamp({ label = "Done" }: { label?: string }) {
  return (
    <div className="seal-stamp" role="img" aria-label={label}>
      <span className="stamp-anim">
        <span className="seal">수호</span>
      </span>
    </div>
  );
}

/** A distinct success mark for places a full seal does not fit (a paired yes/no,
 *  a compact row): a thin geometric check inside a seal-red circle, cleanly
 *  drawn — not a hand-drawn glyph. */
export function SuccessCheck({ size = 24 }: { size?: number }) {
  return (
    <svg
      className="success-check"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Success"
    >
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="var(--seal)" strokeWidth="1.5" />
      <path
        d="M7.5 12.4l3.1 3.1 5.9-6.4"
        fill="none"
        stroke="var(--seal)"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}


export function Spinner() {
  return <span className="spinner" />;
}

/** Inline error: human sentence + a "details" disclosure holding the raw text.
 *  Every surface that used to render String(e) uses this so nothing leaks. */
export function ErrNote({ error, muted }: { error: unknown; muted?: boolean }) {
  const { text, raw } = humanError(error);
  return (
    <div className={muted ? "muted" : "errbox"}>
      {text}
      {raw && raw !== text && (
        <details className="err-details">
          <summary>details</summary>
          <div className="err-raw">{raw}</div>
        </details>
      )}
    </div>
  );
}

export const fmtEth = (wei: bigint | string, digits = 5): string => {
  const v = typeof wei === "string" ? BigInt(wei) : wei;
  const whole = v / 10n ** 18n;
  const frac = v % 10n ** 18n;
  return `${whole}.${frac.toString().padStart(18, "0").slice(0, digits)}`;
};

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
