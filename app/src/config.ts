export const GUARDIAN = "http://localhost:8787";
export const CHAIN_ID = 91342n;
export const NORMAL_RPC = "https://sepolia-rpc.giwa.io";
export const FLASH_RPC = "https://sepolia-rpc-flashblocks.giwa.io";
export const EXPLORER = "https://sepolia-explorer.giwa.io";
// The demo account (alice) — Phase O makes this the LEGACY path; new users
// onboard their own account below.
export const DEMO_ACCOUNT = "0xacc2a6Eb741E147e8D3Ed9213b070656c908Adad" as const;

// Ondol wiring for onboarding (deployments/giwa-sepolia.json)
export const ONDOL_V2_IMPL = "0xC512B2B083a38aa75F20E947feC5ee22AA23Bd69" as const;
export const GUARD_ADDRESS = "0x106953DB14B1183378976E128AE5cd40C4b493d2" as const;
export const ARISE_ADDRESS = "0x827375200CF4595f71b09497A65BAF10Ca907466" as const;

export const LS_ACCOUNT = "suho.account";

/** The account this browser session acts for: onboarded account, or the demo
 *  account on the legacy path. Only the ADDRESS is stored — never any key. */
export function activeAccount(): `0x${string}` {
  return (localStorage.getItem(LS_ACCOUNT) as `0x${string}`) ?? DEMO_ACCOUNT;
}
export function setActiveAccount(address: string): void {
  localStorage.setItem(LS_ACCOUNT, address);
}
export function hasAccount(): boolean {
  return localStorage.getItem(LS_ACCOUNT) !== null;
}
export function isLegacyDemo(): boolean {
  return activeAccount().toLowerCase() === DEMO_ACCOUNT.toLowerCase();
}
export const EAS_ADDRESS = "0x4200000000000000000000000000000000000021" as const;
// Suho Card schema (registered 2026-07-21, deployments/giwa-sepolia.json)
export const CARD_SCHEMA_UID =
  "0x1eb6f3a6fefafeb323d44868d7c4c97ee64c981d9c47c5f028154a29dba0bdaa" as const;
export const OTP_THRESHOLD_WEI = 10_000_000_000_000_000n; // 0.01 ether (guard immutable)
export const LS_CREDENTIAL = "suho.credentialId";
