import {
  decodeFunctionData,
  parseAbi,
  getAddress,
  isAddressEqual,
  type Hex,
  type Address,
} from "viem";
import { publicClient } from "./chain.js";
import { ondolV3Abi, ondolAccountAbi } from "./contracts.js";

/// Phase M on-chain anchor verification. A message is only stored if the tx it
/// references really is a confirmed transfer from the claimed sender to a
/// recipient (M0 rule 1, rule 8). We never trust the client's claim about who
/// paid whom — we read the tx and prove it. The recipient is DISCOVERED from the
/// tx, never supplied by the caller, so a memo/request can't be misdirected.

// A verified transfer. `token` is the sentinel "ETH" for a native-value transfer
// or a lowercased ERC-20 contract address. `amountWei` is the exact amount moved.
// `to` is the recipient read off-chain from the tx.
export interface TransferFacts {
  token: "ETH" | Hex;
  amountWei: bigint;
  from: Hex;
  to: Hex;
}

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

const eq = (a: string, b: string) => {
  try {
    return isAddressEqual(a as Address, b as Address);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
};

// Decode an Ondol account's execute(calls, ...) input into its Call[] array,
// tolerant of both the V3 (4-arg, capped) and legacy V1/V2 (3-arg) shapes. The
// calls array is the first argument in both. Returns null for anything else.
function decodeExecuteCalls(input: Hex): { target: Hex; value: bigint; data: Hex }[] | null {
  for (const abi of [ondolV3Abi, ondolAccountAbi]) {
    try {
      const { functionName, args } = decodeFunctionData({ abi, data: input });
      if (functionName !== "execute") continue;
      const calls = args[0] as readonly { target: Hex; value: bigint; data: Hex }[];
      return calls.map((c) => ({ target: c.target, value: c.value, data: c.data }));
    } catch {
      // not this shape — try the next
    }
  }
  return null;
}

// Does an ERC-20 Transfer(from -> to, amount) log for `token` appear in the
// receipt? Belt-and-suspenders on top of decoding the call: guards against a
// non-standard token whose transfer() returns false without reverting.
function hasErc20TransferLog(
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[],
  token: string,
  from: string,
  to: string,
  amount: bigint,
): boolean {
  for (const log of logs) {
    if (!eq(log.address, token)) continue;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const logFrom = `0x${log.topics[1].slice(-40)}`;
    const logTo = `0x${log.topics[2].slice(-40)}`;
    if (!eq(logFrom, from) || !eq(logTo, to)) continue;
    if (BigInt(log.data) === amount) return true;
  }
  return false;
}

function decodeErc20Transfer(data: Hex | undefined): { to: Hex; amount: bigint } | null {
  if (!data || data.length < 10) return null;
  try {
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
    if (functionName !== "transfer") return null;
    return { to: args[0] as Hex, amount: args[1] as bigint };
  } catch {
    return null;
  }
}

/// Fetch a tx + receipt, retrying a couple of times for RPC lag (a just-mined tx
/// can read empty on a load-balanced node). Returns null if still not found.
async function fetchTx(txHash: Hex) {
  for (let i = 0; i < 3; i++) {
    try {
      const [tx, receipt] = await Promise.all([
        publicClient.getTransaction({ hash: txHash }),
        publicClient.getTransactionReceipt({ hash: txHash }),
      ]);
      if (tx && receipt) return { tx, receipt };
    } catch {
      // not indexed yet
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

/// Verify on-chain that `txHash` is a confirmed transfer of value FROM `from`,
/// and return what moved and to whom. Handles the two shapes a Suho transfer can
/// take:
///
///  1. Ondol execute: the relayer called `execute(calls, ...)` ON the sender's
///     account (`tx.to == from`); we decode the calls and take the outgoing
///     transfer — a native-value call, or an ERC-20 transfer(recipient, amount).
///  2. Direct transfer: a plain EOA send (`tx.from == from`).
///
/// If `expectedTo` is given, the recipient must match it (return-flow checks);
/// otherwise the recipient is discovered and returned. Returns null on any
/// mismatch (wrong sender, reverted, not a transfer). Token-allowlisting is the
/// caller's decision — this only reports what actually moved.
export async function verifyTransfer(
  txHash: Hex,
  from: Address,
  expectedTo?: Address,
): Promise<TransferFacts | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  const found = await fetchTx(txHash);
  if (!found) return null;
  const { tx, receipt } = found;
  if (receipt.status !== "success") return null;

  const wantTo = (recipient: string) => !expectedTo || eq(recipient, expectedTo);
  const fromHex = getAddress(from).toLowerCase() as Hex;

  // Shape 1: Ondol account execute() — the account itself is the tx target.
  if (tx.to && eq(tx.to, from)) {
    const calls = decodeExecuteCalls(tx.input);
    if (calls) {
      for (const c of calls) {
        // native-value payment
        if (c.value > 0n && (!c.data || c.data === "0x") && !eq(c.target, from) && wantTo(c.target)) {
          return { token: "ETH", amountWei: c.value, from: fromHex, to: c.target.toLowerCase() as Hex };
        }
        // ERC-20 transfer(recipient, amount) via the token contract
        const erc = decodeErc20Transfer(c.data);
        if (erc && !eq(erc.to, from) && wantTo(erc.to)) {
          if (hasErc20TransferLog(receipt.logs, c.target, from, erc.to, erc.amount)) {
            return {
              token: c.target.toLowerCase() as Hex,
              amountWei: erc.amount,
              from: fromHex,
              to: erc.to.toLowerCase() as Hex,
            };
          }
        }
      }
    }
  }

  // Shape 2: direct EOA transfer.
  if (eq(tx.from, from)) {
    if (tx.to && tx.value > 0n && (!tx.input || tx.input === "0x") && wantTo(tx.to)) {
      return { token: "ETH", amountWei: tx.value, from: fromHex, to: tx.to.toLowerCase() as Hex };
    }
    const erc = decodeErc20Transfer(tx.input);
    if (erc && tx.to && wantTo(erc.to)) {
      if (hasErc20TransferLog(receipt.logs, tx.to, from, erc.to, erc.amount)) {
        return {
          token: getAddress(tx.to).toLowerCase() as Hex,
          amountWei: erc.amount,
          from: fromHex,
          to: erc.to.toLowerCase() as Hex,
        };
      }
    }
  }

  return null;
}
