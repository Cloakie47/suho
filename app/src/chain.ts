import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  type Hex,
} from "viem";
import { CHAIN_ID, FLASH_RPC, NORMAL_RPC, ONDOL_DELEGATION_TARGETS, SPENDING_GUARD_ADDRESS } from "./config";

export const flashClient = createPublicClient({ transport: http(FLASH_RPC) });
export const normalClient = createPublicClient({ transport: http(NORMAL_RPC) });

/** A transient RPC failure worth retrying: GIWA rate limits (-32016 / "over rate
 *  limit"), 429s, timeouts, and transport/network blips. viem buries the reason in
 *  `.details`/`.shortMessage`, so scan the whole error, not just `.message`. */
function isTransientRpc(e: unknown): boolean {
  const x = e as { details?: string; shortMessage?: string };
  const blob = `${x?.details ?? ""} ${x?.shortMessage ?? ""} ${String(e)}`;
  return /over rate limit|-32016|rate limit|too many request|429|-32603|timeout|timed out|failed to fetch|fetch failed|load failed|network/i.test(blob);
}

/** Retry a read on transient RPC failures with exponential backoff (300ms→1.2s).
 *  Direct Flashblocks reads (nonce, passkey, balance) are the hot path before an
 *  execute; a rate-limit blip there must not surface a raw viem error. */
export async function withRpcRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransientRpc(e) || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
  throw last;
}

const accountAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function passkey() view returns (bytes32 x, bytes32 y)",
]);

const spendingGuardAbi = parseAbi([
  "function limitsOf(address account) view returns (uint128 perTx, uint128 daily)",
  "function spentToday(address account) view returns (uint128)",
  "function remainingToday(address account) view returns (uint128)",
]);

// The guard's daily window is anchored on-chain (Account.windowStart) but has no
// getter, so we read it straight from storage. `accts` is the guard's only storage
// variable → mapping base slot 0; the struct packs spent|windowStart|opNonce into
// base+1 (spent = low 128 bits, windowStart = bits 128-191, opNonce = bits 192-255).
// Verified on-chain against a live account (see the empirical slot check).
const GUARD_WINDOW_MS = 24 * 60 * 60 * 1000;
function acctSlot1(account: Hex): Hex {
  const base = BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, 0n])));
  return `0x${(base + 1n).toString(16).padStart(64, "0")}` as Hex;
}

/** The account's live spending state from the bank-model guard: its limits, what
 *  it has spent in the current 24h window, the remaining daily headroom, and the
 *  window anchor (0 = no active window). Read Flashblocks-fresh with retry (drives
 *  the Limits screen, the over-limit detection on Send, and the reset timer). */
export async function readSpending(
  account: Hex,
): Promise<{ perTx: bigint; daily: bigint; spent: bigint; remaining: bigint; windowStart: bigint }> {
  const [limits, spent, remaining, raw] = await withRpcRetry(() =>
    Promise.all([
      flashClient.readContract({ address: SPENDING_GUARD_ADDRESS, abi: spendingGuardAbi, functionName: "limitsOf", args: [account] }),
      flashClient.readContract({ address: SPENDING_GUARD_ADDRESS, abi: spendingGuardAbi, functionName: "spentToday", args: [account] }),
      flashClient.readContract({ address: SPENDING_GUARD_ADDRESS, abi: spendingGuardAbi, functionName: "remainingToday", args: [account] }),
      flashClient.getStorageAt({ address: SPENDING_GUARD_ADDRESS, slot: acctSlot1(account) }),
    ]),
  );
  const packed = raw ? BigInt(raw) : 0n;
  const windowStart = (packed >> 128n) & ((1n << 64n) - 1n);
  return { perTx: limits[0], daily: limits[1], spent, remaining, windowStart };
}

/** When the current 24h window resets, as an epoch-ms timestamp — or null if no
 *  window is active (windowStart 0, or already elapsed → next send starts a fresh
 *  window). The guard resets when block.timestamp >= windowStart + 24h. */
export function windowResetAt(windowStart: bigint, nowMs = Date.now()): number | null {
  if (windowStart === 0n) return null;
  const resetMs = Number(windowStart) * 1000 + GUARD_WINDOW_MS;
  return resetMs > nowMs ? resetMs : null;
}

/** The account's on-chain P-256 passkey. Ground truth for relinking. */
export async function accountPasskey(account: Hex): Promise<{ x: Hex; y: Hex }> {
  const [x, y] = await withRpcRetry(() =>
    flashClient.readContract({ address: account, abi: accountAbi, functionName: "passkey" }),
  );
  return { x, y };
}

// Our OndolAccount implementations (v1 superseded, v2 current). A 7702 account
/** True if `address` is a live Ondol smart account on chain (Add existing
 *  account validation). The 7702 designator is 0xef0100 + the delegation target,
 *  which for a current account is the PROXY and for a legacy account a V1/V2
 *  impl — the valid set is derived from deployments (ONDOL_DELEGATION_TARGETS),
 *  so it can't drift and reject proxy-fronted accounts. Reads code twice: the
 *  public RPC can serve stale empty code right after activity, and a false
 *  negative here would wrongly reject a real account. */
export async function isOndolAccount(address: Hex): Promise<boolean> {
  const check = async () => {
    const code = (await normalClient.getCode({ address }))?.toLowerCase() ?? "0x";
    if (!code.startsWith("0xef0100")) return false;
    return ONDOL_DELEGATION_TARGETS.includes("0x" + code.slice(8));
  };
  return (await check()) || (await check());
}

export interface Call {
  target: Hex;
  value: bigint;
  data: Hex;
}

/** Fresh account nonce off Flashblocks (read twice; take the max — lag guard).
 *  Each read retries with backoff so a Flashblocks rate-limit blip never surfaces
 *  a raw viem error in the middle of an execute. */
export async function accountNonce(account: Hex): Promise<bigint> {
  const read = () =>
    withRpcRetry(() => flashClient.readContract({ address: account, abi: accountAbi, functionName: "nonce" }));
  const [a, b] = [await read(), await read()];
  return a > b ? a : b;
}

// ERC-1967 implementation slot: a non-zero value means the account is
// proxy-fronted (V3, upgradeable). Legacy V1/V2 leave it empty.
const ERC1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** True for proxy-fronted (V3) accounts, which use the capped execute. */
export async function isUpgradeable(account: Hex): Promise<boolean> {
  const v = await withRpcRetry(() => flashClient.getStorageAt({ address: account, slot: ERC1967_IMPL_SLOT }));
  return !!v && BigInt(v) !== 0n;
}

/** Ground truth for the active implementation behind a proxy: read the ERC-1967
 *  slot FRESH (Flashblocks + retry), never from a possibly-stale /status field.
 *  null = the slot is empty (a non-proxy pinned account, or not yet initialized).
 *  This is the single reliable source for the upgrade selector + version check. */
export async function readImpl(account: Hex): Promise<Hex | null> {
  const v = await withRpcRetry(() => flashClient.getStorageAt({ address: account, slot: ERC1967_IMPL_SLOT }));
  return v && BigInt(v) !== 0n ? (`0x${v.slice(-40)}` as Hex) : null;
}

/** Mirrors the account's execute challenge. V2: keccak(account, chain, nonce,
 *  calls). V3 (maxGasPayment provided): keccak(account, chain, nonce, calls,
 *  maxGasPayment) — the signed cap is part of the challenge. */
export function computeChallenge(
  account: Hex,
  nonce: bigint,
  calls: Call[],
  maxGasPayment?: bigint,
): Hex {
  const base = [
    { type: "address" as const },
    { type: "uint256" as const },
    { type: "uint256" as const },
    {
      type: "tuple[]" as const,
      components: [
        { name: "target", type: "address" as const },
        { name: "value", type: "uint256" as const },
        { name: "data", type: "bytes" as const },
      ],
    },
  ];
  if (maxGasPayment === undefined) {
    return keccak256(encodeAbiParameters(base, [account, CHAIN_ID, nonce, calls]));
  }
  return keccak256(
    encodeAbiParameters([...base, { type: "uint256" as const }], [
      account,
      CHAIN_ID,
      nonce,
      calls,
      maxGasPayment,
    ]),
  );
}

/** Poll Flashblocks (50ms) + normal RPC for the receipt; report timings.
 *  Optional callbacks fire the moment each receipt lands, so a single UI
 *  surface (the lifecycle toast) can mutate pending -> preconfirmed -> final. */
export async function watchReceipt(
  hash: Hex,
  t0: number,
  on?: { preconf?: (ms: number) => void; final?: (ms: number) => void; reverted?: () => void },
): Promise<{ preconfMs: number; inclusionMs: number; status: string }> {
  let preconfMs = 0;
  let inclusionMs = 0;
  let status = "unknown";
  const deadline = Date.now() + 30_000;
  while ((preconfMs === 0 || inclusionMs === 0) && Date.now() < deadline) {
    const [rf, rn] = await Promise.all([
      preconfMs === 0 ? flashClient.getTransactionReceipt({ hash }).catch(() => null) : null,
      inclusionMs === 0 ? normalClient.getTransactionReceipt({ hash }).catch(() => null) : null,
    ]);
    const now = performance.now();
    if (preconfMs === 0 && rf) {
      preconfMs = Math.round(now - t0);
      status = rf.status;
      // A mined-but-reverted tx must never toast success.
      if (rf.status !== "success") {
        on?.reverted?.();
        return { preconfMs, inclusionMs, status };
      }
      on?.preconf?.(preconfMs);
    }
    if (inclusionMs === 0 && rn) {
      inclusionMs = Math.round(now - t0);
      if (rn.status !== "success") {
        status = rn.status;
        on?.reverted?.();
        return { preconfMs, inclusionMs, status };
      }
      on?.final?.(inclusionMs);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { preconfMs, inclusionMs, status };
}
