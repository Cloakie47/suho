import { decodeAbiParameters, type Hex } from "viem";
import { publicClient, flashClient } from "./chain.js";
import { ADDR, CARD_SCHEMA_UID, CARD_ERA_START, easAbi } from "./contracts.js";
import { getScanCursor, setScanCursor, loadCardUids, upsertCardUids } from "./db.js";

/// C2-C5 Suho Card lookup. Cards are self-attested EAS attestations under the Suho
/// Card schema (attester == recipient == the Ondol account), enforced here.
/// Versions chain through refUID; the current card is the sole unrevoked head.
///
/// PERSISTENT CACHE (perf fix): the per-address attestation-uid set and a
/// last-scanned-block cursor live in Postgres. Boot loads them instantly and
/// scans only NEW blocks, so a restart no longer re-pays the ~20s full EAS scan,
/// and getCard no longer blocks on a full historical scan. The DB is best-effort.

const CHUNK = 10_000n;

interface CardVersion {
  uid: Hex;
  displayName: string;
  contact: string;
  remarks: string;
  time: number;
  revocationTime: number;
  refUID: Hex;
}

const ZERO32 = ("0x" + "0".repeat(64)) as Hex;

const cardUids = new Map<string, Set<Hex>>();
let scannedTo = 0n;
let loaded = false;
let refreshing: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    scannedTo = await getScanCursor("card");
    const rows = await loadCardUids();
    for (const { address, uid } of rows) {
      const k = address.toLowerCase();
      if (!cardUids.has(k)) cardUids.set(k, new Set());
      cardUids.get(k)!.add(uid as Hex);
    }
    console.log(`card: loaded ${rows.length} uids from DB (cursor ${scannedTo})`);
  } catch (e) {
    console.warn("card: DB cache unavailable, scanning from history:", String(e).slice(0, 80));
  }
}

/// Scan a block range for self-attested card uids; update memory, return the new
/// (address, uid) pairs for persistence. Empty results cross-checked on Flash.
async function scanRange(from: bigint, to: bigint): Promise<{ address: string; uid: string }[]> {
  const pairs: { address: string; uid: string }[] = [];
  for (let b = from; b <= to; b += CHUNK) {
    const end = b + CHUNK - 1n > to ? to : b + CHUNK - 1n;
    let logs = await publicClient.getLogs({ address: ADDR.eas, event: easAbi[0], args: { schemaUID: CARD_SCHEMA_UID }, fromBlock: b, toBlock: end });
    if (logs.length === 0) {
      logs = await flashClient.getLogs({ address: ADDR.eas, event: easAbi[0], args: { schemaUID: CARD_SCHEMA_UID }, fromBlock: b, toBlock: end });
    }
    for (const log of logs) {
      const { recipient, attester, uid } = log.args;
      if (!recipient || !attester || !uid) continue;
      if (recipient.toLowerCase() !== attester.toLowerCase()) continue; // self-attested only
      const key = recipient.toLowerCase();
      if (!cardUids.has(key)) cardUids.set(key, new Set());
      if (!cardUids.get(key)!.has(uid)) {
        cardUids.get(key)!.add(uid);
        pairs.push({ address: key, uid });
      }
    }
  }
  return pairs;
}

/// Incremental refresh: scan only new blocks since the cursor. Coalesced.
async function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await ensureLoaded();
      const latest = await publicClient.getBlockNumber();
      const from = scannedTo === 0n ? CARD_ERA_START : scannedTo + 1n;
      if (latest >= from) {
        const pairs = await scanRange(from, latest);
        if (pairs.length > 0) {
          try {
            await upsertCardUids(pairs);
          } catch (e) {
            console.warn("card: persist failed:", String(e).slice(0, 80));
          }
        }
      }
      scannedTo = latest;
      try {
        await setScanCursor("card", scannedTo);
      } catch {
        /* best-effort */
      }
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Boot warmup: load from DB (instant) then incrementally scan new blocks. */
export function prewarmCards(): void {
  refresh().catch(() => {
    /* best-effort; getCard refreshes on demand */
  });
}

async function loadVersion(uid: Hex): Promise<CardVersion | null> {
  const a = await publicClient.readContract({ address: ADDR.eas, abi: easAbi, functionName: "getAttestation", args: [uid] });
  if (a.uid === ZERO32) return null;
  let displayName = "";
  let contact = "";
  let remarks = "";
  try {
    [displayName, contact, remarks] = decodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "string" }],
      a.data,
    ) as [string, string, string];
  } catch {
    return null;
  }
  return { uid, displayName, contact, remarks, time: Number(a.time), revocationTime: Number(a.revocationTime), refUID: a.refUID as Hex };
}

export async function getCard(addressOrUid: string): Promise<{
  address: Hex | null;
  current: (CardVersion & { version: number }) | null;
  history: (CardVersion & { version: number })[];
}> {
  await ensureLoaded();
  // Incremental refresh (fast once loaded): keeps a just-created card fresh for
  // the poll-after-write, without ever re-scanning history.
  await refresh();

  let address: Hex | null = null;
  if (/^0x[0-9a-fA-F]{64}$/.test(addressOrUid)) {
    const a = await publicClient.readContract({ address: ADDR.eas, abi: easAbi, functionName: "getAttestation", args: [addressOrUid as Hex] });
    if (a.uid === ZERO32) return { address: null, current: null, history: [] };
    address = a.recipient as Hex;
  } else if (/^0x[0-9a-fA-F]{40}$/.test(addressOrUid)) {
    address = addressOrUid as Hex;
  } else {
    return { address: null, current: null, history: [] };
  }

  const uids = [...(cardUids.get(address.toLowerCase()) ?? [])];
  if (uids.length === 0) return { address, current: null, history: [] };

  const versions = (await Promise.all(uids.map(loadVersion))).filter((v): v is CardVersion => v !== null);
  const live = versions.filter((v) => v.revocationTime === 0).sort((a, b) => b.time - a.time);
  const head = live[0] ?? versions.sort((a, b) => b.time - a.time)[0];
  if (!head) return { address, current: null, history: [] };

  const byUid = new Map(versions.map((v) => [v.uid.toLowerCase(), v]));
  const chain: CardVersion[] = [];
  let cursor: CardVersion | null = head;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.uid.toLowerCase())) {
    seen.add(cursor.uid.toLowerCase());
    chain.push(cursor);
    const ref: Hex = cursor.refUID;
    if (ref === ZERO32) break;
    cursor = byUid.get(ref.toLowerCase()) ?? (await loadVersion(ref));
  }

  const depth = chain.length;
  const numbered = chain.map((v, i) => ({ ...v, version: depth - i }));
  return { address, current: head.revocationTime === 0 ? numbered[0] : null, history: numbered };
}
