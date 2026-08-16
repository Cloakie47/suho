import deployments from "./deployments.json";

// The guardian is a separate origin in production. Set VITE_GUARDIAN_URL at
// build time to the deployed guardian; defaults to the local dev process.
export const GUARDIAN = import.meta.env.VITE_GUARDIAN_URL ?? "http://localhost:8787";
// The docs are a SEPARATE static origin (site/docs), not part of this SPA. A
// relative path would hit Vite's SPA fallback and route to Send, so this must
// be an absolute URL. It points straight at the first content page, never the
// docs root (there is no docs hero). Env-configurable via VITE_DOCS_URL.
export const DOCS_URL =
  import.meta.env.VITE_DOCS_URL ?? "http://localhost:8899/docs/overview/what-is-suho.html";
export const GITHUB_URL = "https://github.com/Cloakie47/suho";
// WebAuthn Relying Party ID — the registrable domain passkeys are bound to. MUST
// be the origin's domain or a parent suffix of it. Dev is "localhost"; in
// production set VITE_RP_ID=suhowallet.com so passkeys created on
// app.suhowallet.com are valid (and portable across the apex). A mismatch makes
// every passkey create/sign fail.
export const RP_ID = import.meta.env.VITE_RP_ID ?? "localhost";
// The landing page (a separate origin). The app wordmark links here as "home".
// Dev: the local static server; prod: suhowallet.com. Env-configurable.
export const LANDING_URL = import.meta.env.VITE_LANDING_URL ?? "http://localhost:8899/";
// This app's own public origin — used to build absolute, shareable links (e.g.
// the card QR -> /verify view) that must resolve for anyone who scans them, not
// just this browser. Set VITE_APP_URL=https://app.suhowallet.com in production;
// dev falls back to the current origin.
export const APP_URL = import.meta.env.VITE_APP_URL ?? window.location.origin;
export const CHAIN_ID = 91342n;
export const NORMAL_RPC = "https://sepolia-rpc.giwa.io";
export const FLASH_RPC = "https://sepolia-rpc-flashblocks.giwa.io";
export const EXPLORER = "https://sepolia-explorer.giwa.io";
// The demo account (alice) — Phase O makes this the LEGACY path; new users
// onboard their own account below.
export const DEMO_ACCOUNT = "0xacc2a6Eb741E147e8D3Ed9213b070656c908Adad" as const;

// Demo/legacy affordances are a DEV convenience. In a PRODUCTION build
// (`vite build`, import.meta.env.DEV === false) they are hidden entirely, so a
// stranger on the live site sees only Create and Recover — never the demo
// account, which only half-works off localhost and confuses real users. Force it
// on for a staging build with VITE_SHOW_DEMO=1 if ever needed.
export const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO === "1";

// Ondol wiring for onboarding — DERIVED from the canonical deployments file
// (contracts/deployments/giwa-sepolia.json), synced into src by the
// predev/prebuild `sync-deployments` script. Never hardcode these: onboarding
// signs the Init digest over GUARD_ADDRESS/ARISE_ADDRESS and the guardian passes
// the same values into initializeWithSig — any drift makes ecrecover fail
// (InvalidInitSignature) and onboarding reverts. Deriving keeps them in lockstep
// with whatever is actually deployed.
const hex = (a: string) => a as `0x${string}`;
export const GUARD_ADDRESS = hex(deployments.ondolTransferGuard);
export const ARISE_ADDRESS = hex(deployments.ariseModule);
export const ONDOL_PROXY = hex(deployments.ondolProxy);
export const ONDOL_V4_IMPL = hex(deployments.ondolAccountV4Impl);
export const ONDOL_V3_IMPL = hex(deployments.ondolAccountV3Impl);
export const ONDOL_V2_IMPL = hex(deployments.ondolAccountV2Impl);
export const ONDOL_V1_IMPL = hex(deployments.ondolAccountImpl);
// Phase M: on-chain memo log. A note is appended as a second call in the same
// execute() batch as the transfer, so memo + money land in one atomic tx.
export const SUHO_MEMO = hex(deployments.suhoMemo);

// Valid 7702 delegation designators for a Suho account (used by "add existing
// account" validation). A current account delegates to the PROXY; legacy
// accounts delegate straight to a V1/V2 impl. Derived from deployments so this
// can never drift the way the old hardcoded impl list did — which rejected every
// proxy-fronted account. Lowercased for comparison against the code designator.
export const ONDOL_DELEGATION_TARGETS: readonly string[] = [
  ONDOL_PROXY,
  ONDOL_V4_IMPL,
  ONDOL_V3_IMPL,
  ONDOL_V2_IMPL,
  ONDOL_V1_IMPL,
].map((a) => a.toLowerCase());

export const LS_ACCOUNT = "suho.account";
export const LS_ACCOUNTS = "suho.accounts";

/** The account this browser session acts for, or null on a truly fresh session
 *  with nothing chosen. Only ADDRESSES are stored, never any key. There is NO
 *  fallback to the demo account: a fresh visitor has no account and must onboard,
 *  recover, or explicitly pick the demo (which sets it via setActiveAccount). */
export function activeAccount(): `0x${string}` | null {
  return localStorage.getItem(LS_ACCOUNT) as `0x${string}` | null;
}
/** For shell code that only runs once an account is selected (behind the
 *  onboarded gate). Throws only on a programming error — never a user path. */
export function requireActiveAccount(): `0x${string}` {
  const a = activeAccount();
  if (!a) throw new Error("No account selected on this device.");
  return a;
}
export function setActiveAccount(address: string): void {
  localStorage.setItem(LS_ACCOUNT, address);
  rememberAccount(address);
}
export function hasAccount(): boolean {
  return localStorage.getItem(LS_ACCOUNT) !== null;
}
export function isLegacyDemo(): boolean {
  const a = activeAccount();
  return a !== null && a.toLowerCase() === DEMO_ACCOUNT.toLowerCase();
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
  const a = activeAccount();
  return a ? credentialFor(a) : null;
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
// At/above this, a send to an unverified address triggers the hold-to-confirm
// step (matches the on-chain guard's otpThreshold). No code — passkey + confirm.
export const LARGE_SEND_THRESHOLD_WEI = 10_000_000_000_000_000n; // 0.01 ether
