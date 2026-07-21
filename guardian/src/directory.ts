import { keccak256, parseAbi, stringToBytes, type Hex } from "viem";
import { publicClient, flashClient } from "./chain.js";
import { ADDR, upnameRegistryAbi } from "./contracts.js";

/// D1: directory of registered up.id names, enumerated from UpnameRegistry
/// NameRegistered events via chunked eth_getLogs, gated at read time on
/// owner != address(0) AND hasActiveName(owner) (the two known registry traps).
///
/// DELIBERATE SPEC DEVIATIONS, from live RPC/registry measurements:
/// 1. Bounded scan. The registry has ~220k registrations (airdrop-bot wave;
///    measured ~0.5 registrations/BLOCK in hot ranges) — a full-history scan is
///    hundreds of MB of logs plus a six-figure gating pass, for zero demo value.
///    We scan from DEMO_ERA_START (fixed block just before our wallets
///    registered) to head instead.
/// 2. CHUNK = 10k blocks. Empirically on this RPC: <=20k works reliably and
///    repeatably, 50k errors InvalidParams, and 100k SILENTLY RETURNS EMPTY —
///    the worst failure mode, so never trust large ranges here.
/// 3. Server-side search + capped responses (still ~60k+ names in-window;
///    shipping that JSON to the browser per keystroke is not a demo).
const DEMO_ERA_START = 31_150_000n;
const CHUNK = 10_000n;
const MIN_CHUNK = 500n; // bisection floor before giving up on a range
const CONCURRENCY = 3; // public RPC rate-limits aggressive fan-out
const RETRIES = 3;
const MAX_ROWS = 500;

const eventAbi = parseAbi(["event NameRegistered(string name, address indexed owner)"]);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Hex; // present on GIWA (probe-checked)

export interface DirEntry {
  name: string;
  address: Hex;
  active: boolean;
}

const seenNames = new Set<string>();
let scannedTo = 0n;
let cachedEntries: DirEntry[] = [];
let gating: Promise<void> | null = null;

/// Fetch one range; bisect on any limit-shaped failure, retry transient ones.
///
/// EMPTY RESULTS ARE SUSPECT on this RPC: the load balancer includes at least
/// one backend whose log index answers ANY range with an empty array instead of
/// an error (observed live — a scan silently lost known events). Every 0-log
/// chunk is therefore cross-checked against the Flashblocks pool; whichever
/// side returns data wins.
async function fetchRange(from: bigint, to: bigint, attempt = 1): Promise<void> {
  try {
    let logs = await publicClient.getLogs({
      address: ADDR.upnameRegistry,
      event: eventAbi[0], // NOTE: this RPC rejects an empty topics array
      fromBlock: from,
      toBlock: to,
    });
    if (logs.length === 0) {
      logs = await flashClient.getLogs({
        address: ADDR.upnameRegistry,
        event: eventAbi[0],
        fromBlock: from,
        toBlock: to,
      });
      if (logs.length > 0) {
        console.warn(`getLogs empty-lie detected on normal RPC for [${from}..${to}]; flashblocks returned ${logs.length}`);
      }
    }
    for (const log of logs) {
      if (log.args.name) seenNames.add(log.args.name);
    }
  } catch (e) {
    const msg = String(e);
    const span = to - from;
    const shouldBisect =
      msg.includes("size limit") ||
      msg.includes("TooLarge") ||
      msg.includes("-32602") ||
      msg.includes("Invalid parameters") ||
      msg.includes("block range") ||
      /limit|too many|exceed/i.test(msg);
    if (shouldBisect && span > MIN_CHUNK) {
      const mid = from + span / 2n;
      await fetchRange(from, mid);
      await fetchRange(mid + 1n, to);
      return;
    }
    if (attempt >= RETRIES) throw e;
    await new Promise((r) => setTimeout(r, 600 * attempt));
    return fetchRange(from, to, attempt + 1);
  }
}

async function scanToHead(): Promise<void> {
  const latest = await publicClient.getBlockNumber();
  const from = scannedTo === 0n ? DEMO_ERA_START : scannedTo + 1n;
  if (latest < from) return;
  const ranges: { from: bigint; to: bigint }[] = [];
  for (let b = from; b <= latest; b += CHUNK) {
    ranges.push({ from: b, to: b + CHUNK - 1n > latest ? latest : b + CHUNK - 1n });
  }
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    await Promise.all(ranges.slice(i, i + CONCURRENCY).map((r) => fetchRange(r.from, r.to)));
  }
  scannedTo = latest;
}

/** Re-gate every seen name against live registry state (multicall batched). */
async function gateEntries(): Promise<void> {
  const names = [...seenNames];
  if (names.length === 0) {
    cachedEntries = [];
    return;
  }
  // batchSize is bytes of aggregate3 calldata per eth_call. 100k-byte batches
  // get rejected wholesale by this RPC (observed: every chunk "failed" and the
  // gate output was silently empty); ~20k works.
  const BATCH = 20_000;

  const owners = await publicClient.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    batchSize: BATCH,
    contracts: names.map((n) => ({
      address: ADDR.upnameRegistry,
      abi: upnameRegistryAbi,
      functionName: "ownerOf" as const,
      args: [BigInt(keccak256(stringToBytes(n)))],
    })),
  });

  const candidates: { name: string; address: Hex }[] = [];
  names.forEach((name, i) => {
    const o = owners[i];
    if (o.status !== "success") return;
    const addr = o.result as Hex;
    if (addr === "0x0000000000000000000000000000000000000000") return; // trap #1
    candidates.push({ name, address: addr });
  });
  if (candidates.length === 0) {
    // 60k names cannot ALL be unowned — the gate itself is broken; don't cache
    // an empty trust surface.
    throw new Error(`directory gate produced zero candidates from ${names.length} names — multicall failing`);
  }

  // One activity check per unique owner (trap #2), then applied to all names.
  const uniqueOwners = [...new Set(candidates.map((c) => c.address))];
  const activity = await publicClient.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    batchSize: BATCH,
    contracts: uniqueOwners.map((o) => ({
      address: ADDR.upnameRegistry,
      abi: upnameRegistryAbi,
      functionName: "hasActiveName" as const,
      args: [o],
    })),
  });
  const activeOwner = new Set(
    uniqueOwners.filter((_, i) => activity[i].status === "success" && activity[i].result === true),
  );

  cachedEntries = candidates
    .filter((c) => activeOwner.has(c.address))
    .map((c) => ({ ...c, active: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  console.log(
    `directory gate: seen=${names.length} owned=${candidates.length} uniqueOwners=${uniqueOwners.length} active=${cachedEntries.length}`,
  );
}

/// Canary: names we KNOW registered inside the scan window and are active. A
/// scan that misses them is incomplete (e.g. a lying RPC node) — refuse to
/// serve a silently-broken trust surface; the next request retries.
const CANARY_NAMES = ["alice", "suho"];

/** Full scan + gate; serialized so concurrent requests share one pass. */
async function rebuild(): Promise<void> {
  if (!gating) {
    gating = (async () => {
      try {
        await scanToHead();
        for (const c of CANARY_NAMES) {
          if (!seenNames.has(c)) {
            scannedTo = 0n; // force a full rescan on the next attempt
            throw new Error(`directory scan canary failed: '${c}' missing — RPC served incomplete logs`);
          }
        }
        await gateEntries();
      } finally {
        gating = null;
      }
    })();
  }
  return gating;
}

/** Fire-and-forget warmup so the first user request is served from cache. */
export function prewarmDirectory(): void {
  rebuild().then(
    () => console.log(`directory prewarmed: ${cachedEntries.length} active names (scanned to ${scannedTo})`),
    (e) => console.error("directory prewarm failed:", String(e).slice(0, 200)),
  );
}

export async function getDirectory(
  q: string,
  refresh: boolean,
): Promise<{ entries: DirEntry[]; total: number; shown: number; scannedToBlock: string }> {
  if (refresh || cachedEntries.length === 0) {
    await rebuild();
  }
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? cachedEntries.filter(
        (e) => e.name.toLowerCase().includes(needle) || e.address.toLowerCase().includes(needle),
      )
    : cachedEntries;
  return {
    entries: filtered.slice(0, MAX_ROWS),
    total: cachedEntries.length,
    shown: Math.min(filtered.length, MAX_ROWS),
    scannedToBlock: scannedTo.toString(),
  };
}
