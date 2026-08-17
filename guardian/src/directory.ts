import { keccak256, parseAbi, stringToBytes, type Hex } from "viem";
import { publicClient, flashClient } from "./chain.js";
import { ADDR, upnameRegistryAbi } from "./contracts.js";
import { getScanCursor, setScanCursor, searchDirectoryNames, countDirectoryNames, upsertDirectoryNames, type DirNameRow } from "./db.js";

/// D1 directory of registered up.id names.
///
/// LAZY-GATE (perf model): the registry holds ~500k names, so eagerly gating and
/// caching them all cost a ~13-min cold build, ~150MB residency, and a ~12s boot
/// (paid on every Railway restart). Instead we persist the RAW name set (name +
/// owner, straight from the NameRegistered event) with a last-scanned-block cursor.
///   - Boot loads only the cursor + a count (instant); no chain reads, no residency.
///   - A request searches the names in SQL and gates only the <=500 it will serve,
///     fresh — so deactivations are caught and the gate is never stale.
///   - Incremental scans (new blocks only) append raw names; served
///     stale-while-revalidate so a request never waits on a scan.
///
/// RPC pathologies handled: 10k-block chunks, bisection on size-limit errors,
/// rate-limit backoff (never bisect a rate limit), a Flashblocks cross-check on
/// empty results, and a call-count-chunked gate that separates a transport/gas
/// batch failure (retry) from a genuine per-call revert (drop) — see callChunk.
const DEMO_ERA_START = 31_150_000n;
const CHUNK = 10_000n;
const MIN_CHUNK = 500n;
const CONCURRENCY = 3;
const RETRIES = 3;
const MAX_ROWS = 500;

const eventAbi = parseAbi(["event NameRegistered(string name, address indexed owner)"]);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";
const CANARY_NAMES = ["alice", "suho"];

export interface DirEntry {
  name: string;
  address: Hex;
  active: boolean;
}

let scannedTo = 0n;
let namesCount = 0; // cached count of registered names, for `total`
let hasNames = false; // does the DB hold any names yet? (gates first-build blocking)
let loaded = false;
let refreshing: Promise<void> | null = null;

const REFRESH_TTL_MS = 60_000;
const MIN_REBUILD_INTERVAL_MS = 30_000;
let lastRefreshAt = 0;
let lastAttemptAt = 0;

// Per-name gate cache: a served request gates its <=500 names, then reuses the
// verdict for a minute so repeated searches don't re-hit the RPC. Bounded.
const gateCache = new Map<string, { address: Hex; active: boolean; ts: number }>();
const GATE_CACHE_TTL_MS = 60_000;
const GATE_CACHE_MAX = 50_000;

/// Load the cursor + name count once. Instant; no chain reads, no residency.
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    scannedTo = await getScanCursor("directory");
    namesCount = await countDirectoryNames();
    hasNames = namesCount > 0;
    console.log(`directory: cursor ${scannedTo}, ${namesCount} names in DB (lazy-gate)`);
  } catch (e) {
    console.warn("directory: DB unavailable:", String(e).slice(0, 80));
  }
}

/// Fetch one range's NameRegistered logs into `found` (name → owner); bisect on
/// size-limit failures, back off on rate limits, cross-check empty on Flashblocks.
async function fetchRange(found: Map<string, Hex>, from: bigint, to: bigint, attempt = 1): Promise<void> {
  try {
    let logs = await publicClient.getLogs({ address: ADDR.upnameRegistry, event: eventAbi[0], fromBlock: from, toBlock: to });
    if (logs.length === 0) {
      logs = await flashClient.getLogs({ address: ADDR.upnameRegistry, event: eventAbi[0], fromBlock: from, toBlock: to });
      if (logs.length > 0) console.warn(`getLogs empty-lie on normal RPC [${from}..${to}]; flash returned ${logs.length}`);
    }
    for (const log of logs) {
      const { name, owner } = log.args;
      if (name && owner) found.set(name, owner as Hex); // last writer wins (latest registration)
    }
  } catch (e) {
    const msg = String(e);
    const span = to - from;
    // Rate limiting (-32016 / "over rate limit") must NOT bisect — splitting the
    // range only multiplies the request count. Back off with escalating delay.
    const rateLimited = /-32016|rate limit|too many request/i.test(msg);
    const bisect = !rateLimited && /size limit|TooLarge|-32602|Invalid parameters|block range|too many|exceed/i.test(msg);
    if (bisect && span > MIN_CHUNK) {
      const mid = from + span / 2n;
      await fetchRange(found, from, mid);
      await fetchRange(found, mid + 1n, to);
      return;
    }
    if (attempt >= RETRIES + (rateLimited ? 3 : 0)) throw e;
    const delay = rateLimited ? 1500 * attempt : 600 * attempt;
    await new Promise((r) => setTimeout(r, delay));
    return fetchRange(found, from, to, attempt + 1);
  }
}

/// Scan new blocks since the cursor and return the newly-seen (name, owner) pairs.
async function scanNew(): Promise<{ pairs: DirNameRow[]; newCursor: bigint }> {
  const latest = await publicClient.getBlockNumber();
  const from = scannedTo === 0n ? DEMO_ERA_START : scannedTo + 1n;
  if (latest < from) return { pairs: [], newCursor: scannedTo };
  const found = new Map<string, Hex>();
  const ranges: { from: bigint; to: bigint }[] = [];
  for (let b = from; b <= latest; b += CHUNK) ranges.push({ from: b, to: b + CHUNK - 1n > latest ? latest : b + CHUNK - 1n });
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    await Promise.all(ranges.slice(i, i + CONCURRENCY).map((r) => fetchRange(found, r.from, r.to)));
  }
  return { pairs: [...found].map(([name, owner]) => ({ name, owner })), newCursor: latest };
}

/// Bounded, retryable multicall. Gating a slice via one giant aggregate3 is unsafe:
/// viem maps a whole failed sub-batch (rate limit, or an eth_call gas cap on a
/// too-large aggregate3) to per-call failures with the batch's error —
/// indistinguishable from a genuine per-call revert. So we chunk by CALL COUNT (a
/// gas-safe aggregate3 per eth_call) and use a clean signal: a WHOLE-chunk failure
/// is transport/gas → retry with backoff, then split; a PARTIAL-chunk failure is
/// genuine per-call reverts (expired names) → drop just those.
type CallResult<T> = { status: "success"; result: T } | { status: "failure"; error?: unknown };
const GATE_CHUNK = 500; // calls per eth_call; keeps aggregate3 well under any gas cap
const GATE_CONCURRENCY = 8;
const GATE_MIN_SPLIT = 25; // below this, a persistent whole-chunk failure is real

async function callChunk<T>(contracts: readonly unknown[], attempt = 1): Promise<(T | null)[]> {
  let res: CallResult<T>[];
  try {
    // batchSize huge → viem issues ONE aggregate3 for this already-bounded chunk.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res = (await publicClient.multicall({ multicallAddress: MULTICALL3, allowFailure: true, batchSize: 8_000_000, contracts: contracts as any })) as CallResult<T>[];
  } catch (e) {
    res = contracts.map(() => ({ status: "failure", error: e }) as CallResult<T>);
  }
  const failed = res.filter((r) => r.status === "failure").length;
  if (failed < res.length) return res.map((r) => (r.status === "success" ? r.result : null));
  if (attempt <= 4) {
    await new Promise((r) => setTimeout(r, 600 * attempt));
    return callChunk<T>(contracts, attempt + 1);
  }
  if (contracts.length > GATE_MIN_SPLIT) {
    const mid = contracts.length >> 1;
    const [a, b] = await Promise.all([callChunk<T>(contracts.slice(0, mid)), callChunk<T>(contracts.slice(mid))]);
    return [...a, ...b];
  }
  throw new Error(`gate chunk stuck after retries (${contracts.length} calls): ${String((res[0] as { error?: unknown }).error).slice(0, 100)}`);
}

async function multicallChunked<T>(contracts: readonly unknown[]): Promise<(T | null)[]> {
  const out: (T | null)[] = [];
  const starts: number[] = [];
  for (let i = 0; i < contracts.length; i += GATE_CHUNK) starts.push(i);
  for (let c = 0; c < starts.length; c += GATE_CONCURRENCY) {
    const group = starts.slice(c, c + GATE_CONCURRENCY);
    const parts = await Promise.all(group.map((s) => callChunk<T>(contracts.slice(s, s + GATE_CHUNK))));
    for (const p of parts) out.push(...p);
  }
  return out;
}

/// Gate a list of names against live registry state: owned AND hasActiveName.
/// Returns the ACTIVE entries with their fresh on-chain owner.
async function gateNames(names: string[]): Promise<DirEntry[]> {
  if (names.length === 0) return [];
  const owners = await multicallChunked<Hex>(
    names.map((n) => ({
      address: ADDR.upnameRegistry,
      abi: upnameRegistryAbi,
      functionName: "ownerOf" as const,
      args: [BigInt(keccak256(stringToBytes(n)))],
    })),
  );
  const candidates: { name: string; address: Hex }[] = [];
  names.forEach((name, i) => {
    const o = owners[i];
    if (o != null && o !== ZERO) candidates.push({ name, address: o });
  });
  if (candidates.length === 0) return [];
  const uniqueOwners = [...new Set(candidates.map((c) => c.address))];
  const activity = await multicallChunked<boolean>(
    uniqueOwners.map((o) => ({ address: ADDR.upnameRegistry, abi: upnameRegistryAbi, functionName: "hasActiveName" as const, args: [o] })),
  );
  const activeOwner = new Set(uniqueOwners.filter((_, i) => activity[i] === true));
  return candidates.filter((c) => activeOwner.has(c.address)).map((c) => ({ ...c, active: true }));
}

/// Gate the <=500 names a request will serve, reusing recent verdicts. The gate is
/// applied at SERVE time (not scan time), so a name that deactivated after it was
/// indexed is correctly dropped — the directory is a live trust surface.
async function gateSlice(rows: DirNameRow[]): Promise<DirEntry[]> {
  const now = Date.now();
  const out: DirEntry[] = [];
  const misses: string[] = [];
  for (const r of rows) {
    const c = gateCache.get(r.name);
    if (c && now - c.ts < GATE_CACHE_TTL_MS) {
      if (c.active) out.push({ name: r.name, address: c.address, active: true });
    } else misses.push(r.name);
  }
  if (misses.length > 0) {
    if (gateCache.size > GATE_CACHE_MAX) gateCache.clear();
    const active = await gateNames(misses);
    const activeMap = new Map(active.map((e) => [e.name, e]));
    for (const name of misses) {
      const e = activeMap.get(name);
      if (e) {
        gateCache.set(name, { address: e.address, active: true, ts: now });
        out.push(e);
      } else {
        gateCache.set(name, { address: ZERO as Hex, active: false, ts: now });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/// Incremental refresh: scan new blocks, persist the raw names, advance the cursor.
/// No gating here — gating happens lazily at serve time. Serialized.
async function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await ensureLoaded();
      const coldScan = !hasNames;
      const { pairs, newCursor } = await scanNew();
      if (pairs.length > 0) {
        if (coldScan) {
          // Canary on the RAW scan: proves getLogs returned complete history.
          const names = new Set(pairs.map((p) => p.name));
          for (const c of CANARY_NAMES) {
            if (!names.has(c)) {
              scannedTo = 0n; // force a full rescan next time
              throw new Error(`directory canary '${c}' missing from scan — RPC served incomplete logs`);
            }
          }
        }
        try {
          await upsertDirectoryNames(pairs);
          hasNames = true;
          namesCount = await countDirectoryNames();
        } catch (e) {
          console.warn("directory: persist failed:", String(e).slice(0, 80));
        }
        console.log(`directory refresh: +${pairs.length} names, total ${namesCount}`);
      }
      scannedTo = newCursor;
      try {
        await setScanCursor("directory", scannedTo);
      } catch {
        /* best-effort */
      }
      lastRefreshAt = Date.now();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Boot warmup: kick an incremental scan (no full load, no residency). */
export function prewarmDirectory(): void {
  lastAttemptAt = Date.now();
  refresh().then(
    () => console.log(`directory ready: ${namesCount} names indexed (to ${scannedTo})`),
    (e) => console.error("directory prewarm failed:", String(e).slice(0, 200)),
  );
}

export async function getDirectory(
  q: string,
  refreshFlag: boolean,
): Promise<{ entries: DirEntry[]; total: number; shown: number; scannedToBlock: string }> {
  await ensureLoaded();
  const now = Date.now();
  const stale = !hasNames || now - lastRefreshAt > REFRESH_TTL_MS;
  if ((stale || refreshFlag) && now - lastAttemptAt > MIN_REBUILD_INTERVAL_MS) {
    lastAttemptAt = now;
    const p = refresh().catch((e) => {
      if (!hasNames) throw e; // nothing to serve yet — surface the first-build error
      console.warn("directory refresh failed; serving indexed set:", String(e).slice(0, 120));
    });
    // Stale-while-revalidate: block only on the first-ever build (nothing to serve).
    if (!hasNames) await p;
  }
  let rows: DirNameRow[] = [];
  try {
    rows = await searchDirectoryNames(q, MAX_ROWS);
  } catch (e) {
    console.warn("directory search failed:", String(e).slice(0, 80));
  }
  const entries = await gateSlice(rows);
  return {
    entries,
    total: namesCount,
    shown: entries.length,
    scannedToBlock: scannedTo.toString(),
  };
}
