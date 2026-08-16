import "./env.js"; // load guardian/.env + root .env before anything reads process.env
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const giwaSepolia = defineChain({
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
  blockExplorers: {
    default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" },
  },
});

export const FLASHBLOCKS_RPC = "https://sepolia-rpc-flashblocks.giwa.io";

// Writes go through the normal RPC; reads that need freshness use Flashblocks.
export const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });
export const flashClient = createPublicClient({
  chain: giwaSepolia,
  transport: http(FLASHBLOCKS_RPC),
});

function requireEnv(name: string): `0x${string}` {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v as `0x${string}`;
}

// Dev-only guardian mode. A production guardian (Railway) does NOT set SUHO_DEV,
// so the demo/alice surfaces below and the /upgrade + /demo-credential endpoints
// simply don't exist there — no alice private key is ever loaded in production.
export const SUHO_DEV = process.env.SUHO_DEV === "1";

// Relayer pays gas; the same key owns SuhoCodeAttester (issuer role for recovery codes).
export const relayerAccount = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));

export const relayerWallet = createWalletClient({
  account: relayerAccount,
  chain: giwaSepolia,
  transport: http(),
});

// Demo-only custody: alice's EOA key signs her one-time 7702 upgrade. Loaded
// ONLY in a dev guardian (SUHO_DEV=1). Null in production — there is no alice-key
// surface at all off the dev box.
export const aliceAccount =
  SUHO_DEV && process.env.ALICE_PRIVATE_KEY
    ? privateKeyToAccount(process.env.ALICE_PRIVATE_KEY as `0x${string}`)
    : null;
export const aliceWallet = aliceAccount
  ? createWalletClient({ account: aliceAccount, chain: giwaSepolia, transport: http() })
  : null;

/// The public RPC is load-balanced and can serve stale state right after a tx
/// (probe-verified). For post-tx assertions, read until two consecutive reads
/// agree (bounded), rather than trusting the first answer.
export async function readTwice<T>(fn: () => Promise<T>, tries = 6, delayMs = 500): Promise<T> {
  let prev: string | undefined;
  let last: T = await fn();
  for (let i = 0; i < tries; i++) {
    const cur = await fn();
    const curKey = JSON.stringify(cur, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    if (prev !== undefined && curKey === prev) return cur;
    prev = curKey;
    last = cur;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}
