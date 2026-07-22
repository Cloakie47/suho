import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  type Hex,
} from "viem";
import { CHAIN_ID, FLASH_RPC, NORMAL_RPC } from "./config";

export const flashClient = createPublicClient({ transport: http(FLASH_RPC) });
export const normalClient = createPublicClient({ transport: http(NORMAL_RPC) });

const accountAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function passkey() view returns (bytes32 x, bytes32 y)",
]);

/** The account's on-chain P-256 passkey. Ground truth for relinking. */
export async function accountPasskey(account: Hex): Promise<{ x: Hex; y: Hex }> {
  const [x, y] = await flashClient.readContract({
    address: account,
    abi: accountAbi,
    functionName: "passkey",
  });
  return { x, y };
}

// Our OndolAccount implementations (v1 superseded, v2 current). A 7702 account
// delegated to either is one of ours; the designator is 0xef0100 + impl addr.
const ONDOL_IMPLS = [
  "0xc512b2b083a38aa75f20e947fec5ee22aa23bd69", // v2 current
  "0xd9933befc6c6ff968c662c30c765ce9740ad8ec4", // v1 superseded
];

/** True if `address` is a live Ondol smart account on chain (Add existing
 *  account validation). Reads code twice: the public RPC can serve stale empty
 *  code right after activity, and a false negative here would wrongly reject a
 *  real account. */
export async function isOndolAccount(address: Hex): Promise<boolean> {
  const check = async () => {
    const code = (await normalClient.getCode({ address }))?.toLowerCase() ?? "0x";
    if (!code.startsWith("0xef0100")) return false;
    return ONDOL_IMPLS.includes("0x" + code.slice(8));
  };
  return (await check()) || (await check());
}

export interface Call {
  target: Hex;
  value: bigint;
  data: Hex;
}

/** Fresh account nonce off Flashblocks (read twice; take the max — lag guard). */
export async function accountNonce(account: Hex): Promise<bigint> {
  const read = () =>
    flashClient.readContract({ address: account, abi: accountAbi, functionName: "nonce" });
  const [a, b] = [await read(), await read()];
  return a > b ? a : b;
}

/** Must mirror OndolAccount: keccak256(abi.encode(account, chainid, nonce, calls)). */
export function computeChallenge(account: Hex, nonce: bigint, calls: Call[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        {
          type: "tuple[]",
          components: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
        },
      ],
      [account, CHAIN_ID, nonce, calls],
    ),
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
