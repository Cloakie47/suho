/** The dojang-style verified seal — the one flourish that must land. */
export function Seal({ small }: { small?: boolean }) {
  return (
    <span className={`seal${small ? " small" : ""}`} title="Dojang-verified">
      수호
    </span>
  );
}

/** Roof-tile curve motif, used as a section divider. */
export function TileDivider() {
  return (
    <svg className="tile-divider" width="220" height="16" viewBox="0 0 220 16" fill="none">
      <path
        d="M0 14 C 30 14, 40 3, 55 3 C 70 3, 80 14, 110 14 C 140 14, 150 3, 165 3 C 180 3, 190 14, 220 14"
        stroke="#e4572e"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.7"
      />
    </svg>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export const fmtEth = (wei: bigint | string, digits = 5): string => {
  const v = typeof wei === "string" ? BigInt(wei) : wei;
  const whole = v / 10n ** 18n;
  const frac = v % 10n ** 18n;
  return `${whole}.${frac.toString().padStart(18, "0").slice(0, digits)}`;
};

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
