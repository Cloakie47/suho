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
} from "./chain.js";
import {
  ADDR,
  ATTESTER_IDS,
  DELEGATION_PREFIX,
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
import { encodeWebAuthnSig, spkiToXY, type BrowserAssertion } from "./webauthn.js";
import { printCodeBanner } from "./banner.js";
import { getDirectory, prewarmDirectory } from "./directory.js";
import { getCard } from "./card.js";

// P4: demo readiness — alice must cover one verified send (0.0002) plus one OTP
// send at threshold+0.001, with 30% margin. Execute gas is relayer-paid, so only
// transfer values count. Threshold is read from the deployed guard at startup.
const VERIFIED_SEND_WEI = 200_000_000_000_000n; // 0.0002 ether
const OTP_MARGIN_WEI = 1_000_000_000_000_000n; // 0.001 ether
let demoRequiredWei = 0n;
(async () => {
  const threshold = await publicClient.readContract({
    address: ADDR.ondolTransferGuard,
    abi: [{ type: "function", name: "otpThreshold", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const,
    functionName: "otpThreshold",
  });
  demoRequiredWei = ((VERIFIED_SEND_WEI + threshold + OTP_MARGIN_WEI) * 13n) / 10n;
  console.log(`demo readiness threshold: ${demoRequiredWei} wei`);
})().catch((e) => console.error("could not read guard threshold:", e));

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
// CORS open to the app's localhost port (spec §2)
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// In-memory mirror of issued arise/otp codes (chain is the source of truth).
const issuedCodes = new Map<string, { expiresAt: number }>();

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

// ---- GET /status?address=0x... ----
app.get("/status", async (req, res) => {
  try {
    const address = String(req.query.address) as Hex;
    const [attester, upId, balance, code] = await Promise.all([
      verifiedBy(address),
      reverseName(address),
      flashClient.getBalance({ address }), // Flashblocks-fresh
      publicClient.getCode({ address }),
    ]);
    // v1 and v2 are both our implementations (v2 = current, v1 = superseded).
    const ours = [ADDR.ondolAccountV2Impl, ADDR.ondolAccountImpl].map(
      (impl) => (DELEGATION_PREFIX + impl.slice(2)).toLowerCase(),
    );
    const isOndol = !!code && ours.includes(code.toLowerCase());
    let initialized = false;
    let accountNonce = "0";
    if (isOndol) {
      initialized = await publicClient.readContract({
        address, abi: ondolAccountAbi, functionName: "initialized",
      });
      accountNonce = (
        await publicClient.readContract({ address, abi: ondolAccountAbi, functionName: "nonce" })
      ).toString();
    }
    res.json({
      address,
      isVerified: attester !== null,
      verifiedBy: attester,
      upId,
      balance: balance.toString(),
      isOndolAccount: isOndol,
      delegatedTo: code && code.startsWith(DELEGATION_PREFIX) ? `0x${code.slice(8)}` : null,
      initialized,
      accountNonce,
      demoReady: demoRequiredWei > 0n ? balance >= demoRequiredWei : true,
      demoRequiredWei: demoRequiredWei.toString(),
    });
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
app.post("/relay", async (req, res) => {
  try {
    const { account, calls, otpCode, webauthn } = req.body as {
      account: Hex;
      calls: { target: Hex; value: string; data?: Hex }[];
      otpCode?: string;
      webauthn: BrowserAssertion;
    };
    const sig = encodeWebAuthnSig(webauthn); // DER -> (r,s) -> low-s, one place
    const txHash = await relayerWallet.writeContract({
      address: account,
      abi: ondolAccountAbi,
      functionName: "execute",
      args: [
        calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data ?? "0x" })),
        otpCode ?? "",
        sig,
      ],
    });
    res.json({ txHash, explorer: explorerTx(txHash) }); // client watches Flashblocks
  } catch (e) {
    // Surface the contract's typed error name (OtpRequired, CodeInvalid, ...)
    // so the app can branch — e.g. open the OTP interstitial.
    const reverted =
      e instanceof BaseError
        ? (e.walk((err) => err instanceof ContractFunctionRevertedError) as
            | ContractFunctionRevertedError
            | undefined)
        : undefined;
    const name = reverted?.data?.errorName;
    if (name) return res.status(400).json({ error: name });
    res.status(500).json({ error: String(e) });
  }
});

// ---- POST /otp/request { account, recipient, value } ----
// Issues the guard OTP for a large transfer to an unverified recipient. Domain
// must be byte-identical to OndolTransferGuard's construction: lowercase hex
// addresses, decimal wei value.
app.post("/otp/request", async (req, res) => {
  try {
    const { account, recipient, value } = req.body as {
      account: Hex;
      recipient: Hex;
      value: string; // decimal wei
    };
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const domain = `suho.guard:${account.toLowerCase()}:${recipient.toLowerCase()}:${BigInt(value).toString()}`;
    const codeHash = keccak256(
      encodePacked(["address", "string", "string"], [account, domain, code]),
    );
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 600);
    const txHash = await relayerWallet.writeContract({
      address: ADDR.suhoCodeAttester,
      abi: suhoCodeAttesterAbi,
      functionName: "issueCode",
      args: [account, domain, codeHash, expiry],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    issuedCodes.set(domain, { expiresAt: Number(expiry) });
    printCodeBanner("TRANSFER", recipient, code);
    res.json({ ok: true, expiresAt: Number(expiry), attestationTx: explorerTx(txHash) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- GET /directory[?q=...][&refresh=1] ----
// D1: active, verified up.id names only — this list IS the trust surface.
// Search is server-side (the in-window name set is ~60k+); responses cap at 500.
app.get("/directory", async (req, res) => {
  try {
    res.json(await getDirectory(String(req.query.q ?? ""), req.query.refresh === "1"));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- GET /card?id=<address-or-uid> ----
// C4/C5: current card + refUID version history for an account (or a card uid).
app.get("/card", async (req, res) => {
  try {
    res.json(await getCard(String(req.query.id ?? "")));
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

    const { address, authorization, initSig, passkey } = req.body as {
      address: Hex;
      authorization: { address: Hex; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number };
      initSig: { v: number; r: Hex; s: Hex };
      passkey: { x: Hex; y: Hex };
    };

    // validate before spending relayer gas
    if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) {
      return res.status(400).json({ error: "invalid address" });
    }
    const code = await publicClient.getCode({ address });
    if (code && code !== "0x") {
      return res.status(400).json({ error: "address already has code — onboarding is for fresh accounts" });
    }
    if (authorization.address.toLowerCase() !== ADDR.ondolAccountV2Impl.toLowerCase()) {
      return res.status(400).json({ error: "authorization must target the OndolAccountV2 implementation" });
    }
    if (authorization.chainId !== giwaSepolia.id && authorization.chainId !== 0) {
      return res.status(400).json({ error: "authorization chainId mismatch" });
    }
    if (authorization.nonce !== 0) {
      return res.status(400).json({ error: "authorization nonce must be 0 (fresh EOA)" });
    }

    const txHash = await relayerWallet.sendTransaction({
      to: address,
      data: encodeFunctionData({
        abi: ondolV2Abi,
        functionName: "initializeWithSig",
        args: [
          passkey.x,
          passkey.y,
          ADDR.ondolTransferGuard,
          ADDR.ariseModule,
          initSig.v,
          initSig.r,
          initSig.s,
        ],
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
    res.json({ status: receipt.status, txHash, explorer: explorerTx(txHash), initialized });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 400) });
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
// Demo glue: alice's account was initialized with the probe E Windows Hello
// credential; the app fetches its id here when localStorage is empty.
app.get("/demo-credential", (_req, res) => {
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
app.post("/arise/request", async (req, res) => {
  try {
    const { account, newPubKeyHash } = req.body as { account: Hex; newPubKeyHash: Hex };
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const domain = `suho.arise:${account.toLowerCase()}:${newPubKeyHash.toLowerCase()}`;
    const codeHash = keccak256(
      encodePacked(["address", "string", "string"], [account, domain, code]),
    );
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 600);
    const txHash = await relayerWallet.writeContract({
      address: ADDR.suhoCodeAttester,
      abi: suhoCodeAttesterAbi,
      functionName: "issueCode",
      args: [account, domain, codeHash, expiry],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    issuedCodes.set(`${account}:${newPubKeyHash}`, { expiresAt: Number(expiry) });

    // Offchain delivery IS part of the show: this console plays the
    // "Upbit Verification Service" on the projector.
    printCodeBanner("RECOVERY", account, code);
    res.json({ ok: true, expiresAt: Number(expiry), attestationTx: explorerTx(txHash) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
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

const PORT = 8787;
app.listen(PORT, () => {
  console.log(`suho guardian on http://localhost:${PORT} (chain ${giwaSepolia.id})`);
  console.log(`relayer/issuer: ${relayerAccount.address}`);
  console.log(`demo EOA:       ${aliceAccount.address}`);
  prewarmDirectory();
});
