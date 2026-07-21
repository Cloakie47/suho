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
  explorerTx,
} from "./contracts.js";
import { resolveName, reverseName } from "./upid.js";
import { encodeWebAuthnSig, spkiToXY, type BrowserAssertion } from "./webauthn.js";
import { printCodeBanner } from "./banner.js";

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
    const isOndol =
      !!code &&
      code.toLowerCase() === (DELEGATION_PREFIX + ADDR.ondolAccountImpl.slice(2)).toLowerCase();
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
      code.toLowerCase() === (DELEGATION_PREFIX + ADDR.ondolAccountImpl.slice(2)).toLowerCase();
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
});
