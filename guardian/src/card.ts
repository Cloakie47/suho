import { decodeAbiParameters, type Hex } from "viem";
import { publicClient, flashClient } from "./chain.js";
import { ADDR, CARD_SCHEMA_UID, CARD_ERA_START, easAbi } from "./contracts.js";

/// C2-C5: Suho Card lookup. Cards are attestations on the real EAS under the
/// Suho Card schema, SELF-attested (attester == recipient == the Ondol account,
/// enforced here at read time — nothing a third party attests can render as a
/// card). Versions chain through refUID; updates revoke the prior version in
/// the same execute() batch, so "current" is the sole unrevoked attestation.
///
/// Enumeration scans EAS `Attested` logs filtered by the card schema from the
/// schema's registration block — a young, sparse range, but the same RPC
/// paranoia applies (10k chunks, flash cross-check on empty results).

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

// address (lowercase) -> set of card attestation uids seen in logs
const cardUids = new Map<string, Set<Hex>>();
let scannedTo = 0n;
let scanning: Promise<void> | null = null;

async function scanRange(from: bigint, to: bigint): Promise<void> {
  for (let b = from; b <= to; b += CHUNK) {
    const end = b + CHUNK - 1n > to ? to : b + CHUNK - 1n;
    let logs = await publicClient.getLogs({
      address: ADDR.eas,
      event: easAbi[0],
      args: { schemaUID: CARD_SCHEMA_UID },
      fromBlock: b,
      toBlock: end,
    });
    if (logs.length === 0) {
      // empty-lie cross-check (see directory.ts for the pathology)
      logs = await flashClient.getLogs({
        address: ADDR.eas,
        event: easAbi[0],
        args: { schemaUID: CARD_SCHEMA_UID },
        fromBlock: b,
        toBlock: end,
      });
    }
    for (const log of logs) {
      const { recipient, attester, uid } = log.args;
      if (!recipient || !attester || !uid) continue;
      if (recipient.toLowerCase() !== attester.toLowerCase()) continue; // self-attested only
      const key = recipient.toLowerCase();
      if (!cardUids.has(key)) cardUids.set(key, new Set());
      cardUids.get(key)!.add(uid);
    }
  }
  scannedTo = to;
}

async function scanToHead(): Promise<void> {
  if (!scanning) {
    scanning = (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const from = scannedTo === 0n ? CARD_ERA_START : scannedTo + 1n;
        if (latest >= from) await scanRange(from, latest);
      } finally {
        scanning = null;
      }
    })();
  }
  return scanning;
}

async function loadVersion(uid: Hex): Promise<CardVersion | null> {
  const a = await publicClient.readContract({
    address: ADDR.eas,
    abi: easAbi,
    functionName: "getAttestation",
    args: [uid],
  });
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
    return null; // malformed data can't render as a card
  }
  return {
    uid,
    displayName,
    contact,
    remarks,
    time: Number(a.time),
    revocationTime: Number(a.revocationTime),
    refUID: a.refUID as Hex,
  };
}

export async function getCard(addressOrUid: string): Promise<{
  address: Hex | null;
  current: (CardVersion & { version: number }) | null;
  history: (CardVersion & { version: number })[];
}> {
  await scanToHead();

  let address: Hex | null = null;
  if (/^0x[0-9a-fA-F]{64}$/.test(addressOrUid)) {
    // uid form (verify view): resolve to the recipient, then proceed as usual
    const a = await publicClient.readContract({
      address: ADDR.eas,
      abi: easAbi,
      functionName: "getAttestation",
      args: [addressOrUid as Hex],
    });
    if (a.uid === ZERO32) return { address: null, current: null, history: [] };
    address = a.recipient as Hex;
  } else if (/^0x[0-9a-fA-F]{40}$/.test(addressOrUid)) {
    address = addressOrUid as Hex;
  } else {
    return { address: null, current: null, history: [] };
  }

  const uids = [...(cardUids.get(address.toLowerCase()) ?? [])];
  if (uids.length === 0) return { address, current: null, history: [] };

  const versions = (await Promise.all(uids.map(loadVersion))).filter(
    (v): v is CardVersion => v !== null,
  );
  const live = versions.filter((v) => v.revocationTime === 0).sort((a, b) => b.time - a.time);
  const head = live[0] ?? versions.sort((a, b) => b.time - a.time)[0];
  if (!head) return { address, current: null, history: [] };

  // Walk the refUID chain from the head — this IS the version history (C4).
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

  // chain[0] = newest; version numbers count from v1 at the root.
  const depth = chain.length;
  const numbered = chain.map((v, i) => ({ ...v, version: depth - i }));
  return {
    address,
    current: head.revocationTime === 0 ? numbered[0] : null,
    history: numbered,
  };
}
