export const GUARDIAN = "http://localhost:8787";
export const CHAIN_ID = 91342n;
export const NORMAL_RPC = "https://sepolia-rpc.giwa.io";
export const FLASH_RPC = "https://sepolia-rpc-flashblocks.giwa.io";
export const EXPLORER = "https://sepolia-explorer.giwa.io";
// The demo account (alice). The app is single-account by design (spec §6).
export const DEMO_ACCOUNT = "0xacc2a6Eb741E147e8D3Ed9213b070656c908Adad" as const;
export const EAS_ADDRESS = "0x4200000000000000000000000000000000000021" as const;
// Suho Card schema (registered 2026-07-21, deployments/giwa-sepolia.json)
export const CARD_SCHEMA_UID =
  "0x1eb6f3a6fefafeb323d44868d7c4c97ee64c981d9c47c5f028154a29dba0bdaa" as const;
export const OTP_THRESHOLD_WEI = 10_000_000_000_000_000n; // 0.01 ether (guard immutable)
export const LS_CREDENTIAL = "suho.credentialId";
