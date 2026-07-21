import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keys live in the repo-root .env only; they are read here and never logged.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

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

// Relayer pays gas; the same key owns SuhoCodeAttester (issuer role).
export const relayerAccount = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY"));
export const issuerAccount = relayerAccount;
// Demo-only custody: alice's EOA key is held solely for the one-time 7702 upgrade
// signature. See the custody note in the app spec / README.
export const aliceAccount = privateKeyToAccount(requireEnv("ALICE_PRIVATE_KEY"));

export const relayerWallet = createWalletClient({
  account: relayerAccount,
  chain: giwaSepolia,
  transport: http(),
});
export const aliceWallet = createWalletClient({
  account: aliceAccount,
  chain: giwaSepolia,
  transport: http(),
});

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
