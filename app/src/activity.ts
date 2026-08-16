import { decodeFunctionData, parseAbi, parseAbiItem, type Hex } from "viem";
import { api } from "./api";
import { requireActiveAccount, EAS_ADDRESS, EXPLORER, SUHO_MEMO } from "./config";
import { normalClient } from "./chain";

/** Activity feed: the wallet's real transactions, read from the explorer API in
 *  the browser, annotated with on-chain memos (SuhoMemo `Memo` events). Phase M
 *  revision — memos are public chain data, read here, not from the guardian. */

export const ARISE_MODULE = "0x827375200CF4595f71b09497A65BAF10Ca907466";

// Both account shapes: legacy V1/V2 execute (3-arg) and V3 execute (4-arg, with
// the signed maxGasPayment). Their selectors DIFFER, so the old code that matched
// only the 3-arg selector silently dropped every V3 send. Decode with whichever
// matches; `calls[0]` (the transfer) is the first arg in both.
const executeV2Abi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function execute(Call[] calls, string otpCode, bytes webAuthnSig) payable",
]);
const executeV3Abi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function execute(Call[] calls, string otpCode, uint256 maxGasPayment, bytes webAuthnSig) payable",
]);
const EXECUTE_SELECTORS = ["0x156c0694", "0x60be62a3"]; // V1/V2, V3

const memoEvent = parseAbiItem("event Memo(address indexed from, address indexed to, string text)");

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
  /** On-chain memo attached to this tx (public), if any. */
  memo?: string;
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

function decodeCalls(input: Hex): { target: Hex; value: bigint; data: Hex }[] | null {
  for (const abi of [executeV2Abi, executeV3Abi]) {
    try {
      const { functionName, args } = decodeFunctionData({ abi, data: input });
      if (functionName !== "execute") continue;
      return args[0] as { target: Hex; value: bigint; data: Hex }[];
    } catch {
      // try the other shape
    }
  }
  return null;
}

/** On-chain memos to/from the account, indexed by (lowercased) tx hash. Reads
 *  SuhoMemo `Memo` events over a bounded recent window (GIWA getLogs is unreliable
 *  past ~100k blocks, so we stay under that). Public data, no auth. */
async function fetchMemos(account: Hex): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!SUHO_MEMO || SUHO_MEMO === "0x") return out;
  try {
    const latest = await normalClient.getBlockNumber();
    const fromBlock = latest > 90_000n ? latest - 90_000n : 0n;
    const [asFrom, asTo] = await Promise.all([
      normalClient.getLogs({ address: SUHO_MEMO, event: memoEvent, args: { from: account }, fromBlock, toBlock: latest }),
      normalClient.getLogs({ address: SUHO_MEMO, event: memoEvent, args: { to: account }, fromBlock, toBlock: latest }),
    ]);
    for (const log of [...asFrom, ...asTo]) {
      const text = (log.args as { text?: string }).text;
      if (text) out.set(log.transactionHash.toLowerCase(), text);
    }
  } catch {
    // memos are best-effort annotation; a getLogs hiccup never blocks activity
  }
  return out;
}

let cache: { items: ActivityItem[]; at: number; account: string; withMemos: boolean } | null = null;

/** Synchronous peek at the cached feed for the current account — lets a screen
 *  paint recent activity instantly, then refresh in the background. */
export function peekActivity(account: string): ActivityItem[] | null {
  return cache && cache.account === account ? cache.items : null;
}

/** @param force bypass the 30s cache (used right after a send).
 *  @param opts.withMemos read on-chain memos (2 getLogs). Default true; the Send
 *         screen passes false so its "Recent sends" strip never blocks on log
 *         queries over the rate-limited RPC. */
export async function fetchActivity(
  force = false,
  opts: { withMemos?: boolean } = {},
): Promise<ActivityItem[]> {
  const withMemos = opts.withMemos ?? true;
  const account = requireActiveAccount();
  // A cache built WITH memos satisfies a no-memos read too; a no-memos cache does
  // not satisfy a with-memos read.
  if (
    !force &&
    cache &&
    cache.account === account &&
    Date.now() - cache.at < 30_000 &&
    (cache.withMemos || !withMemos)
  ) {
    return cache.items;
  }

  const [res, memos] = await Promise.all([
    fetch(`https://sepolia-explorer.giwa.io/api/v2/addresses/${account}/transactions`),
    withMemos ? fetchMemos(account as Hex) : Promise.resolve(new Map<string, string>()),
  ]);
  if (!res.ok) throw new Error(`explorer ${res.status}`);
  const { items } = (await res.json()) as { items: ExplorerTx[] };

  const acct = account.toLowerCase();
  const rows = items.slice(0, 40);

  // Pre-resolve every counterparty identity IN PARALLEL before building the feed.
  // The old code awaited identify() serially inside the loop — up to ~40 back-to-
  // back guardian round-trips over the rate-limited RPC, the main source of the
  // slow feed. identify() caches, so the build loop below hits cache instantly.
  const toIdentify = new Set<Hex>();
  for (const tx of rows) {
    const to = tx.to?.hash.toLowerCase() ?? "";
    const from = tx.from.hash.toLowerCase();
    const input = tx.raw_input ?? "0x";
    if (to === acct && EXECUTE_SELECTORS.some((s) => input.startsWith(s))) {
      const first = decodeCalls(input)?.[0];
      if (first && (first.data ?? "0x") === "0x" && first.target.toLowerCase() !== EAS_ADDRESS.toLowerCase()) {
        toIdentify.add(first.target);
      }
    } else if (to === acct && from !== acct && input === "0x" && BigInt(tx.value) > 0n) {
      toIdentify.add(tx.from.hash);
    }
  }
  await Promise.all([...toIdentify].map((a) => identify(a)));

  const out: ActivityItem[] = [];
  for (const tx of rows) {
    const to = tx.to?.hash.toLowerCase() ?? "";
    const from = tx.from.hash.toLowerCase();
    const input = tx.raw_input ?? "0x";
    const base = {
      hash: tx.hash,
      timestamp: tx.timestamp,
      explorer: `${EXPLORER}/tx/${tx.hash}`,
      memo: memos.get(tx.hash.toLowerCase()),
    };

    if (to === acct && EXECUTE_SELECTORS.some((s) => input.startsWith(s))) {
      // execute(): decode calls; calls[0] is the transfer (calls[1+] may be the
      // batched SuhoMemo.note — its text is already in `memos`).
      const calls = decodeCalls(input);
      const first = calls?.[0];
      if (!first) {
        out.push({ ...base, kind: "send", title: "Passkey transaction" });
      } else if (first.target.toLowerCase() === EAS_ADDRESS.toLowerCase()) {
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
    } else if (to === ARISE_MODULE.toLowerCase()) {
      out.push({ ...base, kind: "arise", title: "Passkey rotated (Arise)" });
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

  cache = { items: out, at: Date.now(), account, withMemos };
  return cache.items;
}
