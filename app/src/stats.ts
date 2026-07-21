/** Session stats for the Send dashboard (R2). Module-level so values survive
 *  screen switches; presentation only — nothing here touches tx logic. */

const state = {
  sends: 0,
  msSamples: [] as number[],
  msByHash: new Map<string, number>(),
};

export function recordSend(txHash: string, preconfMs: number): void {
  state.sends += 1;
  if (preconfMs > 0) {
    state.msSamples.push(preconfMs);
    state.msByHash.set(txHash.toLowerCase(), preconfMs);
  }
}

export function sessionStats(): { sends: number; avgMs: number | null } {
  const avg =
    state.msSamples.length === 0
      ? null
      : Math.round(state.msSamples.reduce((a, b) => a + b, 0) / state.msSamples.length);
  return { sends: state.sends, avgMs: avg };
}

export function measuredMs(txHash: string): number | undefined {
  return state.msByHash.get(txHash.toLowerCase());
}
