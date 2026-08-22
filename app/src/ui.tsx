import { useEffect, useState } from "react";
import { humanError } from "./errors";
import { windowResetAt } from "./chain";

/** Live "Resets in Xh Ym" from the guard's on-chain 24h window anchor (unix
 *  seconds). Re-renders each 30s so the countdown stays honest without a refresh.
 *  windowStart 0 (or already elapsed) => the copy-voice "starts with your next
 *  send" line, since the next send opens a fresh window. */
export function ResetsIn({ windowStart }: { windowStart: bigint }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const reset = windowResetAt(windowStart);
  if (reset === null) return <>Starts with your first send today</>;
  const ms = reset - Date.now();
  if (ms < 60_000) return <>Resets in under a minute</>;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return <>Resets in {h > 0 ? `${h}h ${m}m` : `${m}m`}</>;
}

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

/** GitHub mark (this lucide build dropped brand icons). */
export function GithubMark({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.5v-1.8c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.6.8.5A11.5 11.5 0 0 0 23.5 12C23.5 5.7 18.3.5 12 .5z" />
    </svg>
  );
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
