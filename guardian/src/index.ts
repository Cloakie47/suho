import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeFunctionData,
  keccak256,
  encodePacked,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
} from "viem";
import {
  publicClient,
  flashClient,
  relayerWallet,
  aliceWallet,
  aliceAccount,
  relayerAccount,
  readTwice,
  giwaSepolia,
  SUHO_DEV,
} from "./chain.js";
import {
  ADDR,
  ATTESTER_IDS,
  DELEGATION_PREFIX,
  ERC1967_IMPL_SLOT,
  ondolProxyImpl,
  ondolAccountV5Impl,
  ondolProxyAbi,
  ondolV3Abi,
  GAS_ORACLE,
  gasOracleAbi,
  dojangScrollAbi,
  suhoCodeAttesterAbi,
  ariseModuleAbi,
  ondolAccountAbi,
  ondolV2Abi,
  faucetExtensionAbi,
  registerAbi,
  upnameRegistryAbi,
  explorerTx,
} from "./contracts.js";
import { resolveName, reverseName } from "./upid.js";
import { encodeWebAuthnSig, spkiToXY, verifyAssertion, type BrowserAssertion } from "./webauthn.js";
import {
  initDb,
  warmPool,
  bindRecoveryEmail,
  getRecovery,
  recordEmailEvent,
  countRecentEmailEvents,
  recentOps,
  audit,
} from "./db.js";
import { sendConfirmationCode, sendAriseCode, sendEmailChangeNotice, sendRecoveryChangeAuthCode } from "./email.js";
import { emailHash, decryptEmail } from "./crypto.js";
import { randomInt, randomBytes } from "node:crypto";
import { getDirectory, prewarmDirectory } from "./directory.js";
import { getCard, prewarmCards } from "./card.js";
import { registerMessages } from "./messages.js";
import { registerV4Locks, readLockState } from "./v4locks.js";
import { registerSpendingGuard } from "./spendingguard.js";

const app = express();
app.use(express.json());

// Phase O §O3: the guardian NEVER receives key material on any endpoint —
// onboarding sends only an address, two SIGNATURES, and a public key. This
// middleware asserts it structurally: any request smuggling key-shaped fields
// is rejected before any handler (and before anything could be logged).
const FORBIDDEN_BODY_KEYS = ["privatekey", "private_key", "mnemonic", "seed", "seedphrase", "secret"];
app.use((req, res, next) => {
  if (req.body && typeof req.body === "object") {
    const walk = (o: unknown): boolean => {
      if (!o || typeof o !== "object") return false;
      for (const [k, v] of Object.entries(o)) {
        if (FORBIDDEN_BODY_KEYS.includes(k.toLowerCase().replace(/[^a-z_]/g, ""))) return true;
        if (walk(v)) return true;
      }
      return false;
    };
    if (walk(req.body)) {
      return res.status(400).json({ error: "key material must never be sent to the guardian" });
    }
  }
  next();
});
// CORS. Dev default is open ("*"); in production set SUHO_CORS_ORIGINS to a
// comma-separated allowlist (e.g. "https://suho.vercel.app") and only those
// origins are echoed back. Nothing else about the API changes.
const CORS_ALLOW = (process.env.SUHO_CORS_ORIGINS ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (CORS_ALLOW.includes("*")) {
    res.setHeader("access-control-allow-origin", "*");
  } else if (origin && CORS_ALLOW.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// In-memory mirror of issued arise/otp codes (chain is the source of truth).
const issuedCodes = new Map<string, { expiresAt: number }>();

// Coalesce concurrent identical read requests: while one is in flight, callers
// share its promise instead of firing duplicate RPC fan-outs. Cuts load when
// several tabs/components ask for the same account status, card, or directory at
// once against the rate-limited public RPC.
const inflight = new Map<string, Promise<unknown>>();
function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---- G4: operating in public — relayer floor, onboarding caps, metrics ----
// Below the floor, sponsored onboarding pauses; reimbursed ops keep working.
const RELAYER_FLOOR_WEI = BigInt(process.env.SUHO_RELAYER_FLOOR_WEI ?? "0"); // 0 = disabled
const ONBOARD_DAILY_CAP = Number(process.env.SUHO_ONBOARD_DAILY_CAP ?? "200");
// Hard reserve (independent of the optional floor): if the relayer can't comfortably
// cover a sponsored onboarding, pause it with a clear "needs a top-up" message rather
// than letting the tx fail with a raw revert. ~0.0003 ETH is many GIWA onboardings.
const ONBOARD_MIN_RESERVE_WEI = BigInt(process.env.SUHO_ONBOARD_MIN_RESERVE_WEI ?? "300000000000000");
const startedAt = Date.now();
let relaysServed = 0;
let sponsoredOnboardsToday = 0;
let onboardDayUTC = new Date().getUTCDate();
const onboardedPasskeys = new Set<string>(); // dedup key = public key pair, no PII
let lastError: { at: number; where: string; message: string } | null = null;

function noteError(where: string, e: unknown): void {
  lastError = { at: Date.now(), where, message: String(e).slice(0, 200) };
}
function rollOnboardDay(): void {
  const d = new Date().getUTCDate();
  if (d !== onboardDayUTC) {
    onboardDayUTC = d;
    sponsoredOnboardsToday = 0;
  }
}
let relayerBalCache: { at: number; wei: bigint } | null = null;
async function relayerBalanceCached(ttlMs = 10_000): Promise<bigint> {
  const now = Date.now();
  if (relayerBalCache && now - relayerBalCache.at < ttlMs) return relayerBalCache.wei;
  const wei = await publicClient.getBalance({ address: relayerAccount.address });
  relayerBalCache = { at: now, wei };
  return wei;
}
async function sponsoredOnboardingPaused(): Promise<boolean> {
  if (RELAYER_FLOOR_WEI === 0n) return false;
  return (await relayerBalanceCached()) < RELAYER_FLOOR_WEI;
}

// ---- GET /health (public, no secrets) ----
app.get("/health", async (_req, res) => {
  try {
    rollOnboardDay();
    const [bal, normalHead, flashHead] = await Promise.all([
      relayerBalanceCached(0),
      publicClient.getBlockNumber(),
      flashClient.getBlockNumber().catch(() => 0n),
    ]);
    res.json({
      ok: true,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      relayer: relayerAccount.address, // address only, never the key
      relayerBalanceWei: bal.toString(),
      relayerFloorWei: RELAYER_FLOOR_WEI.toString(),
      sponsoredOnboardingPaused: RELAYER_FLOOR_WEI > 0n && bal < RELAYER_FLOOR_WEI,
      sponsoredOnboardsToday,
      onboardDailyCap: ONBOARD_DAILY_CAP,
      relaysServed,
      chainHead: normalHead.toString(),
      flashHead: flashHead.toString(),
      headLag: (flashHead > normalHead ? flashHead - normalHead : 0n).toString(),
      lastError,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

async function verifiedBy(address: Hex): Promise<string | null> {
  for (const a of ATTESTER_IDS) {
    const ok = await publicClient.readContract({
      address: ADDR.dojangScroll,
      abi: dojangScrollAbi,
      functionName: "isVerified",
      args: [address, a.id],
    });
    if (ok) return a.name;
  }
  return null;
}

/// Decode a viem contract revert into its typed error name (OtpRequired,
/// CodeInvalid, CannotCoverGas, ...). Undefined for non-revert failures.
function revertName(e: unknown): string | undefined {
  const reverted =
    e instanceof BaseError
      ? (e.walk((err) => err instanceof ContractFunctionRevertedError) as
          | ContractFunctionRevertedError
          | undefined)
      : undefined;
  return reverted?.data?.errorName;
}

// G3: recommended maxGasPayment = (representative execute gas * gas price + L1
// upper bound) * 1.25. Same oracle and tx-size V3 uses, so the number the app
// shows and the passkey signs matches what the contract will charge.
const REPRESENTATIVE_EXECUTE_GAS = 350_000n; // a typical guarded send (Phase G0)
const L1_TX_SIZE = 1200n; // matches OndolAccountV3.L1_SIZE_ESTIMATE
const FEE_MARGIN_BPS = 12_500n; // +25%
const L1_ALLOWANCE_FALLBACK = 70_000_000_000n; // matches V3.L1_ALLOWANCE

async function recommendedFee(): Promise<{ maxGasPayment: bigint; gasPrice: bigint; l1: bigint }> {
  const [gasPrice, l1] = await Promise.all([
    publicClient.getGasPrice(),
    publicClient
      .readContract({
        address: GAS_ORACLE,
        abi: gasOracleAbi,
        functionName: "getL1FeeUpperBound",
        args: [L1_TX_SIZE],
      })
      .catch(() => L1_ALLOWANCE_FALLBACK),
  ]);
  const raw = REPRESENTATIVE_EXECUTE_GAS * gasPrice + l1;
  return { maxGasPayment: (raw * FEE_MARGIN_BPS) / 10_000n, gasPrice, l1 };
}

// ---- GET /fee ----
// The recommended maxGasPayment the app shows before the passkey prompt and the
// passkey signs into V3.execute. Informational until V3 accounts exist.
app.get("/fee", async (_req, res) => {
  try {
    const { maxGasPayment, gasPrice, l1 } = await recommendedFee();
    res.json({
      maxGasPayment: maxGasPayment.toString(),
      gasPrice: gasPrice.toString(),
      l1UpperBound: l1.toString(),
      eth: (Number(maxGasPayment) / 1e18).toFixed(9),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- GET /status?address=0x... ----
app.get("/status", async (req, res) => {
  try {
    const address = String(req.query.address);
    // Validate before touching the chain: a malformed address must yield a clean
    // 400, not a 500 with a raw viem error (D3 input validation / E4 no raw trace).
    if (!isAddr(address)) return res.status(400).json({ error: "invalid address" });
    const result = await coalesce(`status:${address.toLowerCase()}`, async () => {
    const [attester, upId, balance, code, implSlot] = await Promise.all([
      verifiedBy(address),
      reverseName(address),
      flashClient.getBalance({ address }), // Flashblocks-fresh
      publicClient.getCode({ address }),
      // Read the ERC-1967 impl slot Flashblocks-fresh: the load-balanced normal RPC
      // can serve a stale/empty slot right after an upgrade, which used to make
      // `implementation` fall back to the proxy address and mislabel the version.
      flashClient.getStorageAt({ address, slot: ERC1967_IMPL_SLOT }),
    ]);

    // The 7702 designator target: proxy (new) or a V1/V2 impl (legacy).
    const designator =
      code && code.startsWith(DELEGATION_PREFIX) ? (`0x${code.slice(8)}` as Hex) : null;
    // A proxy-fronted account has the ERC-1967 slot set (in its own storage);
    // legacy V1/V2 accounts never write it. Non-zero => upgradeable, and the
    // low 20 bytes are the active implementation behind the proxy.
    const activeFromSlot =
      implSlot && BigInt(implSlot) !== 0n ? (`0x${implSlot.slice(-40)}` as Hex) : null;

    // Classify the delegation shape. Explicit address match when the proxy is
    // deployed (config); otherwise the ERC-1967 slot is the structural signal.
    let delegationShape: "proxy" | "v2" | "v1" | "unknown" | "none" = "none";
    let upgradeable = false;
    if (designator) {
      const d = designator.toLowerCase();
      if (ondolProxyImpl && d === ondolProxyImpl.toLowerCase()) {
        delegationShape = "proxy";
        upgradeable = true;
      } else if (d === ADDR.ondolAccountV2Impl.toLowerCase()) {
        delegationShape = "v2";
      } else if (d === ADDR.ondolAccountImpl.toLowerCase()) {
        delegationShape = "v1";
      } else if (activeFromSlot) {
        delegationShape = "proxy"; // proxy address not yet configured
        upgradeable = true;
      } else {
        delegationShape = "unknown";
      }
    }

    const isOndol = delegationShape === "proxy" || delegationShape === "v2" || delegationShape === "v1";
    // A proxy account with an empty slot is delegated but not yet initialized;
    // reading through it would delegatecall address(0). Only read when there is
    // an implementation to dispatch to.
    const readable = isOndol && (delegationShape !== "proxy" || activeFromSlot !== null);
    let initialized = false;
    let accountNonce = "0";
    if (readable) {
      initialized = await publicClient.readContract({
        address, abi: ondolAccountAbi, functionName: "initialized",
      });
      accountNonce = (
        await publicClient.readContract({ address, abi: ondolAccountAbi, functionName: "nonce" })
      ).toString();
    }
    return {
      address,
      isVerified: attester !== null,
      verifiedBy: attester,
      upId,
      balance: balance.toString(),
      isOndolAccount: isOndol,
      delegatedTo: designator,
      delegationShape,
      // The active implementation: behind the proxy if upgradeable, else the
      // designator target for a legacy account.
      implementation: activeFromSlot ?? designator,
      upgradeable,
      initialized,
      accountNonce,
      // V4 email second-factor state (all false/0 on pre-V4 accounts).
      locks: await (async () => {
        const s = readable
          ? await readLockState(address)
          : { sensitiveOpLock: false, emailLargeSendLock: false, sensitiveOpNonce: 0n };
        return {
          sensitiveOpLock: s.sensitiveOpLock,
          emailLargeSendLock: s.emailLargeSendLock,
          sensitiveOpNonce: s.sensitiveOpNonce.toString(),
        };
      })(),
      // Global service state: onboarding pauses when the relayer is below floor.
      sponsoredOnboardingPaused: await sponsoredOnboardingPaused(),
    };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- GET /resolve?name=alice ----
app.get("/resolve", async (req, res) => {
  try {
    const address = await resolveName(String(req.query.name ?? ""));
    if (!address) return res.json({ address: null, verified: false, upId: null });
    const attester = await verifiedBy(address);
    res.json({ address, verified: attester !== null, verifiedBy: attester });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- POST /upgrade { address, passkey: { spkiB64 } | { x, y } } ----
// Demo-only custody: signs the one-time 7702 authorization with the stored demo
// EOA key. Single type-4 tx: alice self-submits with initialize() calldata, so
// the authorization applies and initialize runs (msg.sender == account) in one
// step. Auth-nonce = tx-nonce + 1 (probe-verified rule for self-submission);
// viem's executor:'self' encodes exactly that.
app.post("/upgrade", async (req, res) => {
  // Dev-only: absent in production (no SUHO_DEV => no alice key loaded).
  if (!SUHO_DEV || !aliceWallet || !aliceAccount) {
    return res.status(404).json({ error: "not found" });
  }
  try {
    const { address, passkey } = req.body as {
      address: Hex;
      passkey: { spkiB64?: string; x?: Hex; y?: Hex };
    };
    if (address.toLowerCase() !== aliceAccount.address.toLowerCase()) {
      return res.status(400).json({ error: "demo guardian only holds the key for the demo EOA" });
    }
    const { x, y } = passkey.spkiB64 ? spkiToXY(passkey.spkiB64) : { x: passkey.x!, y: passkey.y! };

    const code = await publicClient.getCode({ address });
    const alreadyDelegated =
      !!code &&
      [ADDR.ondolAccountV2Impl, ADDR.ondolAccountImpl]
        .map((impl) => (DELEGATION_PREFIX + impl.slice(2)).toLowerCase())
        .includes(code.toLowerCase());
    if (alreadyDelegated) {
      const initialized = await publicClient.readContract({
        address, abi: ondolAccountAbi, functionName: "initialized",
      });
      if (initialized) return res.json({ status: "already-upgraded" });
    }

    const authorization = await aliceWallet.signAuthorization({
      contractAddress: ADDR.ondolAccountImpl,
      executor: "self",
    });
    const txHash = await aliceWallet.sendTransaction({
      to: address,
      data: encodeFunctionData({
        abi: ondolAccountAbi,
        functionName: "initialize",
        args: [x, y, ADDR.ondolTransferGuard, ADDR.ariseModule],
      }),
      authorizationList: [authorization],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Post-tx assertions with the read-twice pattern (RPC load-balancer lag).
    const newCode = await readTwice(() => publicClient.getCode({ address }));
    const initialized = await readTwice(() =>
      publicClient.readContract({ address, abi: ondolAccountAbi, functionName: "initialized" }),
    );
    res.json({
      status: receipt.status,
      txHash,
      explorer: explorerTx(txHash),
      code: newCode,
      initialized,
      passkey: { x, y },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- POST /relay { account, calls, otpCode?, webauthn } ----
// Dumb relayer: encodes execute() and pays gas. Authority is the passkey sig.
// ---- POST /sign1271 (Horizon 1 S1: dApp sign-in / message signing) ----
// The /connect popup produced a WebAuthn assertion over `hash` (an EIP-191
// personal_sign digest or an EIP-712 typed-data digest). The guardian owns the
// DER -> (r,s) -> low-s + ABI encoding, so it turns the raw assertion into the
// ERC-1271 signature bytes the account's isValidSignature (OndolAccountV5) expects.
// It first VERIFIES the assertion signs exactly `hash` under the account's live
// on-chain passkey, so a bad or mismatched assertion never becomes a signature.
// Pure read + encode: no passkey material stored, no gas spent.
app.post("/sign1271", async (req, res) => {
  try {
    const { account, hash, assertion } = req.body as { account: Hex; hash: Hex; assertion: BrowserAssertion };
    if (!/^0x[0-9a-fA-F]{40}$/.test(account ?? "")) return res.status(400).json({ error: "invalid account" });
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? "")) return res.status(400).json({ error: "invalid hash" });
    const [x, y] = (await publicClient.readContract({
      address: account,
      abi: ondolAccountAbi,
      functionName: "passkey",
    })) as [Hex, Hex];
    const ok = await verifyAssertion({ x, y }, hash, assertion);
    if (!ok) return res.status(400).json({ error: "assertion does not verify for this account and hash" });
    res.json({ signature: encodeWebAuthnSig(assertion) });
  } catch (e) {
    noteError("sign1271", String(e));
    res.status(500).json({ error: String(e) });
  }
});

app.post("/relay", async (req, res) => {
  try {
    const { account, calls, otpCode, webauthn, maxGasPayment } = req.body as {
      account: Hex;
      calls: { target: Hex; value: string; data?: Hex }[];
      otpCode?: string;
      webauthn: BrowserAssertion;
      maxGasPayment?: string; // present => V3 (capped 4-arg execute)
    };
    const sig = encodeWebAuthnSig(webauthn); // DER -> (r,s) -> low-s, one place
    const encodedCalls = calls.map((c) => ({
      target: c.target,
      value: BigInt(c.value),
      data: c.data ?? "0x",
    }));

    // Proxy-fronted (V3) accounts use the capped 4-arg execute; legacy V1/V2 use
    // the 3-arg execute. The client signs the matching challenge, so the shape is
    // driven by whether it sent a maxGasPayment. preflight eth_calls first so a
    // doomed tx (bad sig, guard revert) never burns relayer gas.
    //
    // NOTE: the guardian mints NO transfer code. A large send to an unverified
    // address is allowed by the on-chain guard on the account's passkey authority
    // alone (the app forces an explicit hold-to-confirm first). The old auto-mint
    // was removed — it satisfied the guard from the same passkey that signed the
    // send, so it was security theater. `otpCode` is accepted for wire-compat but
    // is always "" from the app and unused by the corrected guard.
    const isV3 = maxGasPayment !== undefined && maxGasPayment !== null;
    const submitExecute = async (otp: string, preflightFirst = true): Promise<{ txHash?: Hex; refused?: string }> => {
      if (isV3) {
        const args = [encodedCalls, otp, BigInt(maxGasPayment), sig] as const;
        if (preflightFirst) {
          try {
            await publicClient.simulateContract({ account: relayerAccount.address, address: account, abi: ondolV3Abi, functionName: "execute", args });
          } catch (e) {
            const name = revertName(e);
            if (name) return { refused: name };
            throw e;
          }
        }
        return { txHash: await relayerWallet.writeContract({ address: account, abi: ondolV3Abi, functionName: "execute", args }) };
      }
      const args = [encodedCalls, otp, sig] as const;
      if (preflightFirst) {
        try {
          await publicClient.simulateContract({ account: relayerAccount.address, address: account, abi: ondolAccountAbi, functionName: "execute", args });
        } catch (e) {
          const name = revertName(e);
          if (name) return { refused: name };
          throw e;
        }
      }
      return { txHash: await relayerWallet.writeContract({ address: account, abi: ondolAccountAbi, functionName: "execute", args }) };
    };

    // One passkey signature, one submission. If the preflight refuses (bad
    // passkey sig, or a legacy account still on the old guard fail-closing a large
    // unverified send), surface the typed error — the guardian never mints a code
    // to paper over it.
    const result = await submitExecute(otpCode ?? "");
    if (result.refused) {
      // Record refused preflights so a diagnosis (like the V3/V4 upgradeTo
      // selector mismatch) is visible in /health.lastError and the logs, not
      // just returned to the client.
      noteError("relay/refused", result.refused);
      return res.status(400).json({ error: result.refused });
    }
    relaysServed++;
    res.json({ txHash: result.txHash, explorer: explorerTx(result.txHash!) }); // client watches Flashblocks
  } catch (e) {
    // Surface the contract's typed error name (OtpRequired, CodeInvalid, ...)
    // so the app can branch — e.g. open the OTP interstitial.
    const name = revertName(e);
    if (name) return res.status(400).json({ error: name });
    noteError("relay", e);
    res.status(500).json({ error: String(e) });
  }
});

// ---- Transfer OTP endpoints REMOVED (honest-guard correction) ----
// /otp/request, /otp/challenge and /otp/retrieve are gone. A large send to an
// unverified address is no longer gated by a guardian-minted code (that was
// theater: the same passkey that signed the send caused the code to be minted).
// The barrier is now the account's passkey signature bound to the exact
// (recipient, value) plus the app's hold-to-confirm. Recovery/arise codes — a
// genuinely out-of-band email factor — are unaffected and remain below.

// ---- H5: the /issuer portal is RETIRED as a delivery channel ----
// Recovery codes go to email; transfer codes are retrieved passkey-gated and
// shown only in the app. Monitoring moved to the token-gated /ops. A public code
// display would be an account-takeover vector, which is why it no longer exists.
app.get("/issuer", (_req, res) =>
  res
    .status(410)
    .type("text/plain")
    .send("The issuer portal is retired. Recovery codes are emailed; transfer codes are shown in-app. Monitoring: /ops."),
);
app.get("/issuer/codes", (_req, res) => res.status(410).json({ error: "retired; see /ops" }));

// ---- GET /directory[?q=...][&refresh=1] ----
// D1: active up.id names — this list IS the trust surface. The name set is large
// (~500k on this testnet), so search is server-side in Postgres and the <=500
// names actually served are gated (owned + hasActiveName) fresh at serve time.
app.get("/directory", async (req, res) => {
  try {
    const q = String(req.query.q ?? "");
    const refresh = req.query.refresh === "1";
    res.json(await coalesce(`dir:${q}:${refresh}`, () => getDirectory(q, refresh)));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- GET /card?id=<address-or-uid> ----
// C4/C5: current card + refUID version history for an account (or a card uid).
app.get("/card", async (req, res) => {
  try {
    const id = String(req.query.id ?? "");
    res.json(await coalesce(`card:${id.toLowerCase()}`, () => getCard(id)));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- POST /onboard (Phase O §O3) ----
// Body: { address, authorization {address,chainId,nonce,r,s,yParity}, initSig {v,r,s}, passkey {x,y} }
// ONE relayer-paid type-4 tx: delegate to v2 + initializeWithSig. The EOA needs
// zero gas and its key never leaves the browser — only signatures arrive here.
const onboardHits = new Map<string, number[]>();
const ONBOARD_LIMIT = 10; // per IP per hour — testnet gas is real enough to protect

app.post("/onboard", async (req, res) => {
  try {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const hits = (onboardHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (hits.length >= ONBOARD_LIMIT) {
      return res.status(429).json({ error: "rate limited — try again later" });
    }
    onboardHits.set(ip, [...hits, now]);

    // G4: sponsored onboarding is the only free operation, so it is capped.
    rollOnboardDay();
    if (await sponsoredOnboardingPaused()) {
      // Relayer below floor: pause creation, keep reimbursed ops working.
      return res.status(503).json({ error: "OnboardingPaused" });
    }
    // Hard reserve check (independent of the optional floor): never let a
    // near-empty relayer attempt a sponsored onboarding and fail with a raw
    // revert — pause it with a clear, mappable reason instead.
    if ((await relayerBalanceCached()) < ONBOARD_MIN_RESERVE_WEI) {
      return res.status(503).json({ error: "RelayerUnfunded" });
    }
    if (sponsoredOnboardsToday >= ONBOARD_DAILY_CAP) {
      return res.status(429).json({ error: "OnboardingDailyCapReached" });
    }

    const { address, authorization, initSig, proxySig, passkey } = req.body as {
      address: Hex;
      authorization: { address: Hex; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number };
      initSig: { v: number; r: Hex; s: Hex };
      proxySig: { v: number; r: Hex; s: Hex };
      passkey: { x: Hex; y: Hex };
    };

    // validate before spending relayer gas
    if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) {
      return res.status(400).json({ error: "invalid address" });
    }
    if (!ondolProxyImpl || !ondolAccountV5Impl) {
      return res.status(503).json({ error: "proxy/V5 not configured" });
    }
    // Duplicate-passkey check: one passkey cannot farm onboardings. The key is a
    // public key pair, not PII.
    const pkKey = `${passkey.x.toLowerCase()}:${passkey.y.toLowerCase()}`;
    if (onboardedPasskeys.has(pkKey)) {
      return res.status(400).json({ error: "PasskeyAlreadyOnboarded" });
    }
    const code = await publicClient.getCode({ address });
    if (code && code !== "0x") {
      return res.status(400).json({ error: "address already has code — onboarding is for fresh accounts" });
    }
    // Phase G: new accounts delegate to the PROXY (upgradeable), not straight to
    // an implementation.
    if (authorization.address.toLowerCase() !== ondolProxyImpl.toLowerCase()) {
      return res.status(400).json({ error: "authorization must target the OndolProxy" });
    }
    if (authorization.chainId !== giwaSepolia.id && authorization.chainId !== 0) {
      return res.status(400).json({ error: "authorization chainId mismatch" });
    }
    if (authorization.nonce !== 0) {
      return res.status(400).json({ error: "authorization nonce must be 0 (fresh EOA)" });
    }

    // initData runs initializeWithSig behind the proxy (its own passkey sig); the
    // proxy authorizes the impl choice with the EOA's proxySig. Horizon 1: the impl
    // is V5 (ERC-1271). initializeWithSig is byte-identical across V3/V4/V5, so the
    // V3 ABI fragment encodes it correctly.
    const initData = encodeFunctionData({
      abi: ondolV3Abi,
      functionName: "initializeWithSig",
      args: [
        passkey.x,
        passkey.y,
        ADDR.ondolSpendingGuard, // bank model: new accounts start on the limits guard
        ADDR.ariseModule,
        initSig.v,
        initSig.r,
        initSig.s,
      ],
    });
    const txHash = await relayerWallet.sendTransaction({
      to: address,
      data: encodeFunctionData({
        abi: ondolProxyAbi,
        functionName: "initialize",
        args: [ondolAccountV5Impl, initData, proxySig.v, proxySig.r, proxySig.s],
      }),
      authorizationList: [
        {
          address: authorization.address,
          chainId: authorization.chainId,
          nonce: authorization.nonce,
          r: authorization.r,
          s: authorization.s,
          yParity: authorization.yParity as 0 | 1,
        },
      ],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    // Post-check with patience: right after inclusion, stale load-balanced
    // nodes can still serve empty code (observed live) — the read THROWS on
    // them, so retry with backoff instead of failing a successful onboarding.
    let initialized = false;
    for (let i = 0; i < 6 && !initialized; i++) {
      try {
        initialized = await publicClient.readContract({
          address,
          abi: ondolV2Abi,
          functionName: "initialized",
        });
      } catch {
        // stale node — retry
      }
      if (!initialized) await new Promise((r) => setTimeout(r, 800));
    }
    if (receipt.status === "success") {
      sponsoredOnboardsToday++;
      onboardedPasskeys.add(pkKey);
    }
    res.json({ status: receipt.status, txHash, explorer: explorerTx(txHash), initialized });
  } catch (e) {
    noteError("onboard", e);
    // Never leak a raw TransactionExecutionError to the client — classify into a
    // clean, mappable name (the app turns each into a human sentence).
    const revert = revertName(e);
    const m = String(e);
    if (/insufficient funds/i.test(m)) {
      return res.status(503).json({ error: "RelayerUnfunded" });
    }
    if (revert) {
      // e.g. InvalidInitSignature (init sig / guard mismatch), AlreadyInitialized.
      return res.status(400).json({ error: revert });
    }
    if (/timed out|took too long|fetch failed|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up/i.test(m)) {
      return res.status(504).json({ error: "NetworkTimeout" });
    }
    if (/revert/i.test(m)) {
      return res.status(400).json({ error: "OnboardingReverted" });
    }
    return res.status(500).json({ error: "OnboardingFailed" });
  }
});

// ---- POST /verify-me (Phase O §O4) ----
// Returns the CALL PAYLOAD for Dojang faucet issuance; the app routes it through
// the account's own execute() with a passkey signature. Excavation finding:
// payAndIssueEAS() is permissionless and attests msg.sender — the ACCOUNT
// performs its own verification; no guardian-triggered fallback needed.
app.post("/verify-me", async (req, res) => {
  try {
    const { account } = req.body as { account: Hex };
    const already = await verifiedBy(account);
    if (already) return res.status(400).json({ error: "AlreadyVerified" });
    const fee = await publicClient.readContract({
      address: ADDR.faucetExtension,
      abi: faucetExtensionAbi,
      functionName: "fee",
    });
    res.json({
      calls: [
        {
          target: ADDR.faucetExtension,
          value: fee.toString(),
          data: encodeFunctionData({ abi: faucetExtensionAbi, functionName: "payAndIssueEAS" }),
        },
      ],
      feeWei: fee.toString(),
      attester: "TESTNET FAUCET",
    });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});

// ---- POST /claim-name (Phase O §O4) ----
// Availability check + register(label) payload. The name claim MUST come from
// the account itself (register assigns to msg.sender) — payload only, the app
// executes it passkey-signed.
app.post("/claim-name", async (req, res) => {
  try {
    const { account, label } = req.body as { account: Hex; label: string };
    const clean = (label ?? "").toLowerCase().trim();
    if (!/^[a-z0-9-]{3,32}$/.test(clean)) {
      return res.status(400).json({ error: "InvalidLabel" });
    }
    const existing = await reverseName(account);
    if (existing) return res.status(400).json({ error: "AlreadyNamed" });
    const claimable = await publicClient.readContract({
      address: ADDR.upnameRegistry,
      abi: upnameRegistryAbi,
      functionName: "isClaimable",
      args: [clean],
    });
    if (!claimable) return res.status(400).json({ error: "NameTaken" });
    res.json({
      calls: [
        {
          target: ADDR.upnameRegistry,
          value: "0",
          data: encodeFunctionData({ abi: registerAbi, functionName: "register", args: [clean] }),
        },
      ],
      label: clean,
    });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
});

// ---- GET /demo-credential ----
// Dev-only glue: alice's account was initialized with the probe Windows Hello
// credential; the app fetches its id here when localStorage is empty. Absent in
// production (404 without SUHO_DEV).
app.get("/demo-credential", (_req, res) => {
  if (!SUHO_DEV) return res.status(404).json({ error: "not found" });
  try {
    const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
    const probe = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname2, "../../probe-tmp/webauthn/webauthn-result.json"),
        "utf8",
      ),
    );
    res.json({ credentialId: probe.credentialId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- POST /arise/request { account, newPubKeyHash } ----
// H3: enumeration-resistant. The response is identical whether or not the
// account exists or has recovery, and nothing is displayed anywhere — the code
// is only ever emailed to the bound address. A public code display would be an
// account-takeover vector, which is why it does not exist.
const ARISE_GENERIC = { message: "If this account has recovery enabled, a code has been sent." };
app.post("/arise/request", async (req, res) => {
  try {
    const { account, newPubKeyHash } = req.body as { account: Hex; newPubKeyHash: Hex };
    if (!isAddr(account) || typeof newPubKeyHash !== "string") return res.json(ARISE_GENERIC);

    const rec = await getRecovery(account);
    if (rec) {
      const [byAcct, byEmail] = await Promise.all([
        countRecentEmailEvents({ address: account, kind: "arise", windowMs: HOUR }),
        countRecentEmailEvents({ emailHashHex: rec.hash, kind: "arise", windowMs: HOUR }),
      ]);
      if (byAcct < ARISE_MAX_PER_HOUR && byEmail < ARISE_MAX_PER_HOUR) {
        const code = sixDigit();
        const domain = `suho.arise:${account.toLowerCase()}:${newPubKeyHash.toLowerCase()}`;
        const codeHash = keccak256(encodePacked(["address", "string", "string"], [account, domain, code]));
        const expiry = BigInt(Math.floor(Date.now() / 1000) + 600);
        const txHash = await relayerWallet.writeContract({
          address: ADDR.suhoCodeAttester,
          abi: suhoCodeAttesterAbi,
          functionName: "issueCode",
          args: [account, domain, codeHash, expiry],
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        issuedCodes.set(`${account}:${newPubKeyHash}`, { expiresAt: Number(expiry) });
        await sendAriseCode(decryptEmail(rec.encrypted), code, account, 10);
        await recordEmailEvent(account, rec.hash, "arise");
        await audit("arise.request.sent", account);
      } else {
        await audit("arise.request.ratelimited", account);
      }
    }
    // Always identical, even on rate-limit or no recovery. No enumeration.
    res.json(ARISE_GENERIC);
  } catch (e) {
    noteError("arise/request", e);
    // Even on internal error, do not leak — same generic response.
    res.json(ARISE_GENERIC);
  }
});

// ---- POST /arise/complete { account, newX, newY, code } ----
app.post("/arise/complete", async (req, res) => {
  try {
    const { account, newX, newY, code } = req.body as {
      account: Hex; newX: Hex; newY: Hex; code: string;
    };
    const txHash = await relayerWallet.writeContract({
      address: ADDR.ariseModule,
      abi: ariseModuleAbi,
      functionName: "arise",
      args: [account, newX, newY, code],
    });
    // P6: return immediately — the client watches Flashblocks for the receipt
    // and shows the real measured preconfirmation time, same as sends.
    res.json({ status: "submitted", txHash, explorer: explorerTx(txHash) });
  } catch (e) {
    const reverted =
      e instanceof BaseError
        ? (e.walk((err) => err instanceof ContractFunctionRevertedError) as
            | ContractFunctionRevertedError
            | undefined)
        : undefined;
    if (reverted?.data?.errorName) return res.status(400).json({ error: reverted.data.errorName });
    res.status(500).json({ error: String(e) });
  }
});

// ======================= Phase H: real recovery delivery =======================
const HOUR = 3_600_000;
const CONFIRM_MAX_PER_HOUR = Number(process.env.SUHO_EMAIL_CONFIRM_MAX_PER_HOUR ?? "5");
const ARISE_MAX_PER_HOUR = Number(process.env.SUHO_ARISE_EMAIL_MAX_PER_HOUR ?? "3");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sixDigit = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
const isAddr = (a: unknown): a is Hex => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

// Pending email-confirmation codes (transient, in memory). The DB records what
// is BOUND; this holds only the unconfirmed code.
const pendingConfirm = new Map<string, { email: string; code: string; expiresAt: number }>();

// Passkey-gate challenges (in memory), keyed by `${purpose}:${account}`.
const gateChallenges = new Map<string, { challenge: Hex; expiresAt: number }>();
function issueGate(purpose: string, account: string): Hex {
  const challenge = `0x${randomBytes(32).toString("hex")}` as Hex;
  gateChallenges.set(`${purpose}:${account.toLowerCase()}`, { challenge, expiresAt: Date.now() + 5 * 60_000 });
  return challenge;
}
// Verify a passkey assertion over the issued challenge against the account's
// on-chain P-256 key — proves the caller controls the account.
async function passGate(purpose: string, account: Hex, webauthn: BrowserAssertion): Promise<boolean> {
  const key = `${purpose}:${account.toLowerCase()}`;
  const c = gateChallenges.get(key);
  if (!c || c.expiresAt < Date.now()) return false;
  let x: Hex, y: Hex;
  try {
    // read-twice: a fresh account's passkey can read stale/empty on a
    // load-balanced node right after onboarding.
    [x, y] = (await readTwice(() =>
      publicClient.readContract({ address: account, abi: ondolAccountAbi, functionName: "passkey" }),
    )) as [Hex, Hex];
  } catch {
    return false;
  }
  const ok = await verifyAssertion({ x, y }, c.challenge, webauthn);
  if (ok) gateChallenges.delete(key);
  return ok;
}

// ---- GET /recovery/challenge?account= ----
app.get("/recovery/challenge", (req, res) => {
  const account = String(req.query.account ?? "");
  if (!isAddr(account)) return res.status(400).json({ error: "invalid account" });
  res.json({ challenge: issueGate("recovery", account), expiresAt: Date.now() + 5 * 60_000 });
});

// ---- POST /recovery/request-code { account, email, webauthn } ----
// Passkey-gated: only the account controller may set its recovery email.
// Without it an attacker could bind their own email and then recover the account
// — a full takeover vector. Sends a 6-digit confirmation code to the email; on a
// change (an existing different binding) it also notices the old address.
app.post("/recovery/request-code", async (req, res) => {
  try {
    const { account, email, webauthn } = req.body as {
      account: Hex;
      email: string;
      webauthn: BrowserAssertion;
    };
    if (!isAddr(account)) return res.status(400).json({ error: "invalid account" });
    if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: "invalid email" });
    }
    if (!(await passGate("recovery", account, webauthn))) {
      return res.status(401).json({ error: "PasskeyRequired" });
    }
    const eh = emailHash(email);
    const [byAcct, byEmail] = await Promise.all([
      countRecentEmailEvents({ address: account, kind: "confirm", windowMs: HOUR }),
      countRecentEmailEvents({ emailHashHex: eh, kind: "confirm", windowMs: HOUR }),
    ]);
    if (byAcct >= CONFIRM_MAX_PER_HOUR || byEmail >= CONFIRM_MAX_PER_HOUR) {
      return res.status(429).json({ error: "RateLimited" });
    }
    const code = sixDigit();
    pendingConfirm.set(account.toLowerCase(), {
      email: email.trim(),
      code,
      expiresAt: Date.now() + 10 * 60_000,
    });
    // G3 gate: on a LOCKED account, CHANGING the recovery email requires proving
    // control of the CURRENT address, so a passkey-only attacker cannot rotate
    // the recovery channel to their own inbox and then Arise-takeover. When
    // locked AND changing, the confirmation code goes to the OLD address; the
    // rebind can only be confirmed by whoever reads the current recovery email.
    const existing = await getRecovery(account);
    const changing = !!existing && existing.hash !== eh;
    const locked = changing ? (await readLockState(account)).sensitiveOpLock : false;
    if (locked && existing) {
      await sendRecoveryChangeAuthCode(decryptEmail(existing.encrypted), code);
    } else {
      await sendConfirmationCode(email.trim(), code);
    }
    await recordEmailEvent(account, eh, "confirm");
    // Always notify the old address of a change attempt (unlocked path keeps its
    // heads-up; the locked path already routed the code there).
    if (changing && !locked && existing) {
      try {
        await sendEmailChangeNotice(decryptEmail(existing.encrypted));
      } catch (e) {
        noteError("recovery/change-notice", e);
      }
    }
    await audit("recovery.request-code", account);
    res.json({ ok: true });
  } catch (e) {
    noteError("recovery/request-code", e);
    res.status(500).json({ error: "could not send the confirmation code" });
  }
});

// ---- POST /recovery/confirm { account, email, code } ----
// The code proves email control; request-code already proved account control.
app.post("/recovery/confirm", async (req, res) => {
  try {
    const { account, email, code } = req.body as { account: Hex; email: string; code: string };
    if (!isAddr(account)) return res.status(400).json({ error: "invalid account" });
    const p = pendingConfirm.get(account.toLowerCase());
    if (
      !p ||
      p.expiresAt < Date.now() ||
      p.code !== String(code) ||
      p.email.toLowerCase() !== String(email ?? "").trim().toLowerCase()
    ) {
      return res.status(400).json({ error: "CodeInvalid" });
    }
    await bindRecoveryEmail(account, p.email);
    pendingConfirm.delete(account.toLowerCase());
    await audit("recovery.bound", account);
    res.json({ ok: true });
  } catch (e) {
    noteError("recovery/confirm", e);
    res.status(500).json({ error: String(e) });
  }
});

// ---- GET /recovery?account= (on/off only) ----
// Returns whether recovery is enabled, and deliberately NOT the masked email:
// revealing the email to any caller was an enumeration/targeting leak (a stranger
// could learn account X's recovery address). The masked email is no longer served
// on any public endpoint; recovery delivery just goes to the address on file.
app.get("/recovery", async (req, res) => {
  try {
    const account = String(req.query.account ?? "");
    if (!isAddr(account)) return res.status(400).json({ error: "invalid account" });
    const rec = await getRecovery(account);
    res.json({ enabled: rec !== null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- GET /ops (bearer-gated; no codes, no emails, no secrets) ----
app.get("/ops", async (req, res) => {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!process.env.SUHO_OPS_TOKEN || token !== process.env.SUHO_OPS_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    rollOnboardDay();
    const [bal, ops] = await Promise.all([relayerBalanceCached(0), recentOps(30)]);
    res.json({
      relayer: relayerAccount.address,
      relayerBalanceWei: bal.toString(),
      sponsoredOnboardsToday,
      relaysServed,
      lastError,
      recentEmailEvents: ops.events,
      recentAudit: ops.audit,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- Phase M: transaction-attached messages (memos + return requests) ----
// Registered here so the message routes can reuse the guardian's Dojang check
// (verifiedBy) and error sink (noteError). All anchoring, passkey gating, and
// at-rest encryption live in ./messages + ./txverify + ./db.
registerMessages(app, { verifiedBy, noteError });

// ---- Phase SEC 2.3: OndolAccountV4 email second factor (op-code minting) ----
registerV4Locks(app, { passGate, issueGate, noteError });

// ---- Bank model: spend / limit code minting for OndolSpendingGuard ----
registerSpendingGuard(app, { noteError });

// PORT from env for hosted deploys (Railway injects it); 8787 for local dev.
const PORT = Number(process.env.PORT) || 8787;
app.listen(PORT, async () => {
  console.log(`suho guardian on :${PORT} (chain ${giwaSepolia.id})`);
  console.log(`relayer/issuer: ${relayerAccount.address}`);
  if (SUHO_DEV && aliceAccount) console.log(`demo EOA (dev):  ${aliceAccount.address}`);
  console.log(`CORS: ${CORS_ALLOW.includes("*") ? "open (*)" : CORS_ALLOW.join(", ")}`);
  try {
    await initDb();
    await warmPool();
    console.log("db: schema ready (pool warmed)");
  } catch (e) {
    console.log(`db: unavailable (recovery disabled) — ${String(e).slice(0, 80)}`);
  }
  prewarmDirectory();
  prewarmCards();
});
