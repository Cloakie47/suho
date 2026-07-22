import { humanError } from "./errors";

/** The dojang-style verified seal — the one flourish that must land. */
export function Seal({ small, large }: { small?: boolean; large?: boolean }) {
  return (
    <span className={`seal${small ? " small" : ""}${large ? " large" : ""}`} title="Dojang-verified">
      수호
    </span>
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
