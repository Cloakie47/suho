import { decodeAbiParameters, decodeFunctionData, parseAbi, parseAbiItem, type Hex } from "viem";
import { api } from "./api";
import { requireActiveAccount, EAS_ADDRESS, EXPLORER, SUHO_MEMO, ARISE_ADDRESS, SPENDING_GUARD_ADDRESS } from "./config";
import { normalClient, withRpcRetry } from "./chain";
import { shortAddr } from "./ui";

/** Activity feed: the wallet's real transactions, read from the explorer API in
 *  the browser, annotated with on-chain memos (SuhoMemo `Memo` events). Phase M
 *  revision — memos are public chain data, read here, not from the guardian. */

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

// ERC-20 transfer(address,uint256): the money-moving call inside a token send's
// execute batch. Its recipient/amount live in the calldata, not call.value.
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const erc20MetaAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export interface ActivityItem {
  hash: Hex;
  kind: "send" | "received" | "arise" | "card" | "upgrade" | "transfer" | "limits" | "settings";
  title: string;
  counterparty?: Hex;
  counterpartyName?: string | null;
  /** true = verified, false = confirmed NOT verified, undefined = unknown (a read
   *  failed) — the UI must show unknown as neutral, never a false "unverified". */
  verified?: boolean;
  /** ETH wei, or the token's smallest unit when `token` is set. */
  amountWei?: bigint;
  /** Display symbol: "ETH" for native, else the token's symbol (or short address). */
  token?: string;
  /** Decimals for formatting a non-ETH amount. */
  tokenDecimals?: number;
  timestamp: string;
  explorer: string;
  /** On-chain memo attached to this tx (public), if any. */
  memo?: string;
}

/** A decoded money movement inside an execute() batch: native ETH or an ERC-20
 *  transfer. `token` is "ETH" for native, else the token contract address. */
interface Movement {
  token: "ETH" | Hex;
  recipient: Hex;
  amount: bigint;
}

/** Find the primary transfer in a batch, wherever it sits — the decoder used to
 *  read calls[0] only, so a memo-first batch or a token transfer (calldata, not
 *  value) rendered blank. Scans every call for the first ETH value move or ERC-20
 *  transfer, skipping the memo (SuhoMemo), the EAS card attestation, and any guard
 *  op so they don't masquerade as the transfer. */
function primaryTransfer(calls: { target: Hex; value: bigint; data: Hex }[]): Movement | null {
  for (const c of calls) {
    const data = (c.data ?? "0x").toLowerCase();
    if (data === "0x") {
      if (c.value > 0n) return { token: "ETH", recipient: c.target, amount: c.value };
      continue;
    }
    if (data.startsWith(ERC20_TRANSFER_SELECTOR) && data.length >= 138) {
      try {
        const [recipient, amount] = decodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          `0x${data.slice(10)}` as Hex,
        ) as [Hex, bigint];
        return { token: c.target, recipient, amount };
      } catch {
        /* not a clean transfer; keep scanning */
      }
    }
  }
  return null;
}

// Token metadata (symbol + decimals) per address, cached. Never blocks: a read
// failure falls back to a short-address symbol and 18 decimals.
const tokenMetaCache = new Map<string, { symbol: string; decimals: number }>();
async function tokenMeta(token: Hex): Promise<{ symbol: string; decimals: number }> {
  const key = token.toLowerCase();
  const hit = tokenMetaCache.get(key);
  if (hit) return hit;
  let meta = { symbol: `${token.slice(0, 6)}…`, decimals: 18 };
  try {
    const [symbol, decimals] = await withRpcRetry(() =>
      Promise.all([
        normalClient.readContract({ address: token, abi: erc20MetaAbi, functionName: "symbol" }),
        normalClient.readContract({ address: token, abi: erc20MetaAbi, functionName: "decimals" }),
      ]),
    );
    meta = { symbol: symbol || meta.symbol, decimals: Number(decimals) };
  } catch {
    /* keep the short-address fallback */
  }
  tokenMetaCache.set(key, meta);
  return meta;
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

// Cache identity lookups per counterparty (guardian /status). `verified` is
// `undefined` when the read failed — we NEVER cache or render that as a false
// "unverified", because a rate-limit blip must not brand a verified human wrong.
const idCache = new Map<string, { name: string | null; verified: boolean | undefined }>();
async function identify(addr: Hex): Promise<{ name: string | null; verified: boolean | undefined }> {
  const key = addr.toLowerCase();
  const hit = idCache.get(key);
  if (hit) return hit;
  try {
    const s = await api.status(addr);
    const v = { name: s.upId, verified: s.isVerified };
    idCache.set(key, v); // only cache a real answer
    return v;
  } catch {
    return { name: null, verified: undefined }; // unknown, NOT unverified — and not cached
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

  // Pre-resolve counterparty identities AND token metadata in parallel before
  // building the feed (identify()/tokenMeta() cache, so the build loop is instant).
  const toIdentify = new Set<Hex>();
  const toMeta = new Set<Hex>();
  for (const tx of rows) {
    const to = tx.to?.hash.toLowerCase() ?? "";
    const from = tx.from.hash.toLowerCase();
    const input = tx.raw_input ?? "0x";
    if (to === acct && EXECUTE_SELECTORS.some((s) => input.startsWith(s))) {
      const calls = decodeCalls(input);
      const mv = calls ? primaryTransfer(calls) : null;
      if (mv) {
        toIdentify.add(mv.recipient);
        if (mv.token !== "ETH") toMeta.add(mv.token);
      }
    } else if (to === acct && from !== acct && input === "0x" && BigInt(tx.value) > 0n) {
      toIdentify.add(tx.from.hash);
    }
  }
  await Promise.all([...[...toIdentify].map((a) => identify(a)), ...[...toMeta].map((t) => tokenMeta(t))]);

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
      // execute(): decode the batch. Find the real money movement wherever it sits
      // (ETH value OR an ERC-20 transfer), not just calls[0]. calls[1+] may be the
      // batched SuhoMemo.note — its text is already in `memos`.
      const calls = decodeCalls(input);
      const firstTarget = calls?.[0]?.target.toLowerCase();
      const mv = calls ? primaryTransfer(calls) : null;
      if (firstTarget === EAS_ADDRESS.toLowerCase()) {
        out.push({ ...base, kind: "card", title: "Card attested via passkey" });
      } else if (mv) {
        const who = await identify(mv.recipient);
        const meta = mv.token === "ETH" ? null : await tokenMeta(mv.token);
        out.push({
          ...base,
          kind: "send",
          title: `Sent to ${who.name ? `${who.name}.up.id` : shortAddr(mv.recipient)}`,
          counterparty: mv.recipient,
          counterpartyName: who.name,
          verified: who.verified,
          amountWei: mv.amount,
          token: meta ? meta.symbol : "ETH",
          tokenDecimals: meta?.decimals,
        });
      } else if (firstTarget === SPENDING_GUARD_ADDRESS.toLowerCase()) {
        out.push({ ...base, kind: "limits", title: "Limits updated", counterparty: SPENDING_GUARD_ADDRESS });
      } else if (firstTarget === acct) {
        // A self-call op with calldata: setGuard / upgradeTo / enable a lock. Not a
        // limits change — its own "settings" kind so it never reads as one.
        out.push({ ...base, kind: "settings", title: "Account settings changed", counterparty: account as Hex });
      } else if (firstTarget) {
        out.push({ ...base, kind: "send", title: "Contract call via passkey", counterparty: calls![0].target });
      } else {
        out.push({ ...base, kind: "send", title: "Passkey transaction" });
      }
    } else if (to === ARISE_ADDRESS.toLowerCase()) {
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
