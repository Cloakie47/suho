import { keccak256, stringToBytes, toHex, type Hex } from "viem";
import { publicClient } from "./chain.js";
import { ADDR, upnameRegistryAbi } from "./contracts.js";

/// up.id resolution per probe C (binding note 1):
/// - tokenId = keccak256(bare label) — no namehash, no separate resolver.
/// - ownerOf REVERTS for unregistered names: that's the normal not-found case.
/// - every name we display is gated on hasActiveName(owner).

/** "alice" or "alice.up.id" -> owning address, or null if unregistered/inactive. */
export async function resolveName(name: string): Promise<Hex | null> {
  const label = name.toLowerCase().replace(/\.up\.id$/, "");
  if (!/^[a-z0-9-]+$/.test(label)) return null;
  const tokenId = BigInt(keccak256(stringToBytes(label)));
  let owner: Hex;
  try {
    owner = await publicClient.readContract({
      address: ADDR.upnameRegistry,
      abi: upnameRegistryAbi,
      functionName: "ownerOf",
      args: [tokenId],
    });
  } catch {
    return null; // unregistered — normal case, not an error
  }
  // Empirical (live-checked): this registry returns address(0) for unregistered
  // names rather than reverting, AND hasActiveName(address(0)) returns true —
  // so the zero-address must be rejected before the active-name gate.
  if (owner === "0x0000000000000000000000000000000000000000") return null;
  const active = await publicClient.readContract({
    address: ADDR.upnameRegistry,
    abi: upnameRegistryAbi,
    functionName: "hasActiveName",
    args: [owner],
  });
  return active ? owner : null;
}

/** address -> active up.id label, or null. */
export async function reverseName(address: Hex): Promise<string | null> {
  const tokenId = await publicClient.readContract({
    address: ADDR.upnameRegistry,
    abi: upnameRegistryAbi,
    functionName: "ownedTokenId",
    args: [address],
  });
  if (tokenId === 0n) return null;
  const active = await publicClient.readContract({
    address: ADDR.upnameRegistry,
    abi: upnameRegistryAbi,
    functionName: "hasActiveName",
    args: [address],
  });
  if (!active) return null;
  return publicClient.readContract({
    address: ADDR.upnameRegistry,
    abi: upnameRegistryAbi,
    functionName: "getLabel",
    args: [toHex(tokenId, { size: 32 })],
  });
}
