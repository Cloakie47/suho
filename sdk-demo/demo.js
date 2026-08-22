// Suhoswap — the S1.4 demo dApp. Proves @suho/ondol end to end: connect, SIWE
// sign-in verified on-chain via ERC-1271, and arbitrary message signing.
import { createOndolProvider, verifyOndolSignature } from "./ondol.js";
import { hashMessage } from "https://esm.sh/viem@2.21.55";

// Point at the local Suho app + guardian in dev, the deployed ones otherwise.
const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const APP_URL = local ? "http://localhost:5173" : "https://app.suhowallet.com";
const GUARDIAN = local ? "http://localhost:8787" : "https://api.suhowallet.com";
const GIWA_RPC = "https://sepolia-rpc.giwa.io";

const suho = createOndolProvider({ appUrl: APP_URL });
let account = null;

const $ = (id) => document.getElementById(id);
const show = (el, html) => { el.innerHTML = html; el.classList.add("show"); };
const clearErr = (el) => (el.textContent = "");

async function upIdFor(address) {
  try {
    const r = await fetch(`${GUARDIAN}/status?address=${address}`);
    const s = await r.json();
    return { upId: s.upId, verified: s.isVerified };
  } catch {
    return { upId: null, verified: false };
  }
}

function nonce() {
  return Math.random().toString(36).slice(2, 12);
}

const shortSig = (s) => `${s.slice(0, 14)}…${s.slice(-6)}`;
const disclosure = (sig) => `<details class="sig"><summary>Show signature</summary><pre>${sig}</pre></details>`;

$("signin").onclick = async () => {
  clearErr($("signinErr"));
  $("signin").disabled = true;
  try {
    const [addr] = await suho.request({ method: "eth_requestAccounts" });
    account = addr;

    const message =
      `${location.host} wants you to sign in with your Ethereum account:\n${addr}\n\n` +
      `Sign in to the Suho SDK demo.\n\nURI: ${location.origin}\nVersion: 1\n` +
      `Chain ID: 91342\nNonce: ${nonce()}\nIssued At: ${new Date().toISOString()}`;

    const signature = await suho.request({ method: "personal_sign", params: [message, addr] });
    const ok = await verifyOndolSignature(hashMessage(message), signature, addr, GIWA_RPC);
    const { upId, verified } = await upIdFor(addr);

    show(
      $("signinResult"),
      `<div class="kv"><span class="k">Sign-in</span><span class="v ${ok ? "verified" : "failed"}">${ok ? "✓ verified on-chain (ERC-1271)" : "✗ verification failed"}</span></div>
       <div class="kv"><span class="k">Signed in as</span><span class="v">${upId ? upId + ".up.id" : "—"}</span></div>
       <div class="kv"><span class="k">Account</span><span class="v">${addr}</span></div>
       <div class="kv"><span class="k">Human verified</span><span class="v">${verified ? '<span class="verified">✓ Dojang</span>' : "unverified"}</span></div>
       <div class="kv"><span class="k">Signature</span><span class="v">${shortSig(signature)}</span></div>
       <div class="kv"><span class="k">Suho Card</span><span class="v"><a href="${APP_URL}/#/verify/${addr}" target="_blank">/verify/${addr.slice(0, 10)}…</a></span></div>
       ${disclosure(signature)}`,
    );
    $("disconnect").style.display = "";
    $("sign").disabled = false;
  } catch (e) {
    $("signinErr").textContent = e?.message || String(e);
  } finally {
    $("signin").disabled = false;
  }
};

$("disconnect").onclick = () => {
  account = null;
  $("signinResult").classList.remove("show");
  $("disconnect").style.display = "none";
  $("sign").disabled = true;
  $("signResult").classList.remove("show");
};

$("sign").onclick = async () => {
  clearErr($("signErr"));
  if (!account) return;
  $("sign").disabled = true;
  try {
    const message = $("msg").value || "gm";
    const signature = await suho.request({ method: "personal_sign", params: [message, account] });
    const ok = await verifyOndolSignature(hashMessage(message), signature, account, GIWA_RPC);
    show(
      $("signResult"),
      `<div class="kv"><span class="k">Result</span><span class="v ${ok ? "verified" : "failed"}">${ok ? "✓ verified on-chain (ERC-1271)" : "✗ verification failed"}</span></div>
       <div class="kv"><span class="k">Message</span><span class="v">${message.replace(/</g, "&lt;")}</span></div>
       <div class="kv"><span class="k">Signature</span><span class="v">${shortSig(signature)}</span></div>
       ${disclosure(signature)}`,
    );
  } catch (e) {
    $("signErr").textContent = e?.message || String(e);
  } finally {
    $("sign").disabled = false;
  }
};
