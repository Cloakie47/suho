import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { api } from "./api";
import { DEMO_ACCOUNT, EAS_ADDRESS, EXPLORER } from "./config";

/** Activity feed (R2): the wallet's real transactions, read straight from the
 *  explorer API in the browser (CORS `*` verified) — presentation-only data,
 *  no guardian or contract changes (R6). */

export const ARISE_MODULE = "0x827375200CF4595f71b09497A65BAF10Ca907466";

const executeAbi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function execute(Call[] calls, string otpCode, bytes webAuthnSig) payable",
]);

export interface ActivityItem {
  hash: Hex;
  kind: "send" | "received" | "arise" | "card" | "upgrade" | "transfer";
  title: string;
  counterparty?: Hex;
  counterpartyName?: string | null;
  verified?: boolean;
  amountWei?: bigint;
  timestamp: string;
  explorer: string;
}

interface ExplorerTx {
  hash: Hex;
  from: { hash: Hex };
  to: { hash: Hex } | null;
  value: string;
  raw_input?: `0x${string}`;
  method?: string | null;
  timestamp: string;
}

// cache identity lookups per counterparty (guardian /status — existing endpoint)
const idCache = new Map<string, { name: string | null; verified: boolean }>();
async function identify(addr: Hex): Promise<{ name: string | null; verified: boolean }> {
  const key = addr.toLowerCase();
  const hit = idCache.get(key);
  if (hit) return hit;
  try {
    const s = await api.status(addr);
    const v = { name: s.upId, verified: s.isVerified };
    idCache.set(key, v);
    return v;
  } catch {
    const v = { name: null, verified: false };
    idCache.set(key, v);
    return v;
  }
}

let cache: { items: ActivityItem[]; at: number } | null = null;

export async function fetchActivity(): Promise<ActivityItem[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.items;

  const res = await fetch(
    `https://sepolia-explorer.giwa.io/api/v2/addresses/${DEMO_ACCOUNT}/transactions`,
  );
  if (!res.ok) throw new Error(`explorer ${res.status}`);
  const { items } = (await res.json()) as { items: ExplorerTx[] };

  const acct = DEMO_ACCOUNT.toLowerCase();
  const out: ActivityItem[] = [];
  for (const tx of items.slice(0, 20)) {
    const to = tx.to?.hash.toLowerCase() ?? "";
    const from = tx.from.hash.toLowerCase();
    const input = tx.raw_input ?? "0x";
    const base = {
      hash: tx.hash,
      timestamp: tx.timestamp,
      explorer: `${EXPLORER}/tx/${tx.hash}`,
    };

    if (to === acct && input.startsWith("0x156c0694")) {
      // execute(): decode the first call to find the real action
      try {
        const { args } = decodeFunctionData({ abi: executeAbi, data: input });
        const calls = args[0];
        const first = calls[0];
        if (first.target.toLowerCase() === EAS_ADDRESS.toLowerCase()) {
          out.push({ ...base, kind: "card", title: "Card attested via passkey" });
        } else if ((first.data ?? "0x") === "0x") {
          const who = await identify(first.target);
          out.push({
            ...base,
            kind: "send",
            title: `Sent to ${who.name ? `${who.name}.up.id` : "unverified address"}`,
            counterparty: first.target,
            counterpartyName: who.name,
            verified: who.verified,
            amountWei: first.value,
          });
        } else {
          out.push({ ...base, kind: "send", title: "Contract call via passkey" });
        }
      } catch {
        out.push({ ...base, kind: "send", title: "Passkey transaction" });
      }
    } else if (to === ARISE_MODULE.toLowerCase()) {
      out.push({ ...base, kind: "arise", title: "Passkey rotated — Arise" });
    } else if (to === acct && from === acct && input.startsWith("0x1f57365e")) {
      out.push({ ...base, kind: "upgrade", title: "Upgraded to smart account (EIP-7702)" });
    } else if (to === acct && from !== acct && input === "0x" && BigInt(tx.value) > 0n) {
      const who = await identify(tx.from.hash);
      out.push({
        ...base,
        kind: "received",
        title: `Received from ${who.name ? `${who.name}.up.id` : "address"}`,
        counterparty: tx.from.hash,
        counterpartyName: who.name,
        verified: who.verified,
        amountWei: BigInt(tx.value),
      });
    } else if (from === acct && to !== acct && input === "0x" && BigInt(tx.value) > 0n) {
      out.push({
        ...base,
        kind: "transfer",
        title: "Outgoing transfer (pre-upgrade)",
        counterparty: tx.to?.hash,
        amountWei: BigInt(tx.value),
      });
    }
    // everything else (0-value self test txs, deploys) stays out of the feed
  }

  cache = { items: out.slice(0, 10), at: Date.now() };
  return cache.items;
}
