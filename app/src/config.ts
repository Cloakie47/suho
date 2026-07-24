export const GUARDIAN = "http://localhost:8787";
// The docs are a SEPARATE static origin (site/docs), not part of this SPA. A
// relative path would hit Vite's SPA fallback and route to Send, so this must
// be an absolute URL. It points straight at the first content page, never the
// docs root (there is no docs hero). Env-configurable via VITE_DOCS_URL.
export const DOCS_URL =
  import.meta.env.VITE_DOCS_URL ?? "http://localhost:8899/docs/overview/what-is-suho.html";
export const GITHUB_URL = "https://github.com/Cloakie47/suho";
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
export const LS_ACCOUNTS = "suho.accounts";

/** The account this browser session acts for: onboarded account, or the demo
 *  account on the legacy path. Only ADDRESSES are stored. Never any key. */
export function activeAccount(): `0x${string}` {
  return (localStorage.getItem(LS_ACCOUNT) as `0x${string}`) ?? DEMO_ACCOUNT;
}
export function setActiveAccount(address: string): void {
  localStorage.setItem(LS_ACCOUNT, address);
  rememberAccount(address);
}
export function hasAccount(): boolean {
  return localStorage.getItem(LS_ACCOUNT) !== null;
}
export function isLegacyDemo(): boolean {
  return activeAccount().toLowerCase() === DEMO_ACCOUNT.toLowerCase();
}

/** Accounts this device knows (skill v2: there is no logout, there are
 *  accounts). Registry of addresses only. */
export function knownAccounts(): `0x${string}`[] {
  let list: string[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem(LS_ACCOUNTS) ?? "[]");
    if (Array.isArray(raw)) list = raw.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  } catch {
    list = [];
  }
  const cur = localStorage.getItem(LS_ACCOUNT);
  if (cur && !list.some((a) => a.toLowerCase() === cur.toLowerCase())) list.unshift(cur);
  return list as `0x${string}`[];
}
export function rememberAccount(address: string): void {
  const list = knownAccounts();
  if (!list.some((a) => a.toLowerCase() === address.toLowerCase())) list.push(address as `0x${string}`);
  localStorage.setItem(LS_ACCOUNTS, JSON.stringify(list));
}
/** Forgets the local entry only. The account lives on chain; the passkey
 *  still exists in this device's credential manager. */
export function forgetAccount(address: string): void {
  const list = knownAccounts().filter((a) => a.toLowerCase() !== address.toLowerCase());
  localStorage.setItem(LS_ACCOUNTS, JSON.stringify(list));
  localStorage.removeItem(credKey(address));
}

/** Per-account passkey credential ids (WebAuthn credential id, public).
 *  STRICTLY per-account. The old shared slot (suho.credentialId) is dead: it
 *  was the InvalidPasskeySignature-after-switching bug. Every account stored
 *  into it, so after a switch the signing prompt was pinned to whichever
 *  credential was written LAST, by any account. No fallback, no guessing:
 *  an unmapped account reads null and must be relinked (chain-verified). */
const credKey = (a: string) => `suho.credential.${a.toLowerCase()}`;
export function storedCredential(): string | null {
  return credentialFor(activeAccount());
}
export function credentialFor(address: string): string | null {
  return localStorage.getItem(credKey(address));
}
export function storeCredential(address: string, credentialId: string): void {
  localStorage.setItem(credKey(address), credentialId);
}
export const EAS_ADDRESS = "0x4200000000000000000000000000000000000021" as const;
// Suho Card schema (registered 2026-07-21, deployments/giwa-sepolia.json)
export const CARD_SCHEMA_UID =
  "0x1eb6f3a6fefafeb323d44868d7c4c97ee64c981d9c47c5f028154a29dba0bdaa" as const;
export const OTP_THRESHOLD_WEI = 10_000_000_000_000_000n; // 0.01 ether (guard immutable)
