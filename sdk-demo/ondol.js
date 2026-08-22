/**
 * @suho/ondol — add Suho as your dApp's wallet in a few lines.
 *
 * Suho's passkeys are origin-bound to the Suho app, so all signing UI must live
 * on the Suho origin. This SDK opens `https://app.suhowallet.com/#/connect` in a
 * popup and speaks an origin-checked postMessage protocol to it: the popup shows
 * who is asking and what they want, runs one passkey tap, and returns the result.
 *
 * Security model (SDK side):
 *   - We only accept messages whose `event.origin` is the Suho app origin AND
 *     whose `event.source` is the popup window we opened.
 *   - We send the request to that exact origin (never "*").
 *   - One in-flight request at a time; the popup binds exactly one request.
 */
const PROTO = 1;
const DEFAULT_APP_URL = "https://app.suhowallet.com";
const GIWA_CHAIN_ID_HEX = "0x164ce"; // 91342
const REQUEST_TIMEOUT_MS = 120000;
/** A JSON-RPC-style error, shaped like EIP-1193 provider errors. */
export class OndolRpcError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "OndolRpcError";
        this.code = code;
    }
}
function randomId() {
    try {
        return crypto.randomUUID();
    }
    catch {
        return `${Date.now().toString(16)}-${Math.floor(Math.random() * 1e9).toString(16)}`;
    }
}
/**
 * Create an EIP-1193-style provider backed by the Suho popup.
 *
 * ```ts
 * import { createOndolProvider } from "@suho/ondol";
 * const suho = createOndolProvider();
 * const [address] = await suho.request({ method: "eth_requestAccounts" });
 * const sig = await suho.request({ method: "personal_sign", params: [message, address] });
 * ```
 */
export function createOndolProvider(options = {}) {
    const appUrl = (options.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, "");
    const appOrigin = new URL(appUrl).origin;
    let accounts = [];
    let inflight = false;
    const listeners = new Map();
    function emit(event, ...args) {
        listeners.get(event)?.forEach((l) => {
            try {
                l(...args);
            }
            catch {
                /* a listener throwing must not break the provider */
            }
        });
    }
    /** Open the popup, run the origin-checked handshake, resolve with the result. */
    function popupRequest(method, params) {
        if (inflight) {
            return Promise.reject(new OndolRpcError(-32002, "A Suho request is already in progress."));
        }
        inflight = true;
        const id = randomId();
        return new Promise((resolve, reject) => {
            const width = 420;
            const height = 640;
            const left = Math.max(0, Math.round((window.screen.width - width) / 2));
            const top = Math.max(0, Math.round((window.screen.height - height) / 2));
            const popup = window.open(`${appUrl}/#/connect`, "suho:connect", `width=${width},height=${height},left=${left},top=${top},resizable,scrollbars`);
            if (!popup) {
                inflight = false;
                reject(new OndolRpcError(4100, "Popup blocked. Allow popups for this site to use Suho."));
                return;
            }
            let settled = false;
            let sentRequest = false;
            const cleanup = () => {
                window.removeEventListener("message", onMessage);
                clearInterval(closeTimer);
                clearTimeout(timeoutTimer);
                inflight = false;
            };
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                fn();
            };
            const onMessage = (e) => {
                if (e.origin !== appOrigin)
                    return; // only the Suho app origin
                if (e.source !== popup)
                    return; // only the window we opened
                const d = e.data;
                if (!d || d.v !== PROTO)
                    return;
                if (d.__suho === "ready" && !sentRequest) {
                    sentRequest = true;
                    // Send to the EXACT app origin, never "*".
                    popup.postMessage({ __suho: "req", v: PROTO, id, method, params }, appOrigin);
                    return;
                }
                if (d.__suho === "res" && d.id === id) {
                    if (d.error)
                        finish(() => reject(new OndolRpcError(d.error?.code ?? 4001, d.error?.message ?? "Request failed.")));
                    else
                        finish(() => resolve(d.result));
                    try {
                        popup.close();
                    }
                    catch {
                        /* already closed */
                    }
                }
            };
            window.addEventListener("message", onMessage);
            // The user closing the popup rejects the pending request.
            const closeTimer = setInterval(() => {
                if (popup.closed)
                    finish(() => reject(new OndolRpcError(4001, "User closed the window.")));
            }, 400);
            const timeoutTimer = setTimeout(() => {
                try {
                    popup.close();
                }
                catch {
                    /* ignore */
                }
                finish(() => reject(new OndolRpcError(4001, "Suho request timed out.")));
            }, REQUEST_TIMEOUT_MS);
        });
    }
    async function request(args) {
        const method = args?.method;
        const params = (Array.isArray(args?.params) ? args.params : []);
        switch (method) {
            case "eth_chainId":
                return GIWA_CHAIN_ID_HEX;
            case "net_version":
                return String(parseInt(GIWA_CHAIN_ID_HEX, 16));
            case "eth_accounts":
                return accounts;
            case "eth_requestAccounts": {
                const result = (await popupRequest(method, params));
                accounts = Array.isArray(result) ? result : [];
                emit("connect", { chainId: GIWA_CHAIN_ID_HEX });
                emit("accountsChanged", accounts);
                return accounts;
            }
            case "personal_sign":
            case "eth_signTypedData_v4":
                return popupRequest(method, params);
            case "eth_sendTransaction":
                throw new OndolRpcError(4200, "eth_sendTransaction is not supported yet — it arrives in the Suho SDK's next stage (S2).");
            default:
                throw new OndolRpcError(4200, `The Suho provider does not support "${method}".`);
        }
    }
    function on(event, listener) {
        if (!listeners.has(event))
            listeners.set(event, new Set());
        listeners.get(event).add(listener);
    }
    function removeListener(event, listener) {
        listeners.get(event)?.delete(listener);
    }
    return { request, on, removeListener, isSuho: true };
}
// ---- backend verification helper (zero deps) ----
const ERC1271_MAGIC = "0x1626ba7e";
function strip0x(h) {
    return h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
}
/**
 * Verify a Suho sign-in / message signature on-chain via ERC-1271. Calls the
 * account's `isValidSignature(hash, signature)` over any JSON-RPC endpoint and
 * returns true iff it returns the magic value. Use this in a dApp backend to
 * confirm a SIWE sign-in with one function — no wallet libraries required.
 *
 * `hash` is the exact 32-byte digest that was signed (e.g. the EIP-191 hash of a
 * SIWE message, or the EIP-712 digest of typed data). `signature` is the value the
 * provider returned. Binding the hash to intent (domain, nonce, expiry) is the
 * message format's job — this only checks the current passkey signed this hash.
 */
export async function verifyOndolSignature(hash, signature, account, rpcUrl) {
    const h = strip0x(hash).padStart(64, "0");
    const sig = strip0x(signature);
    const sigLen = (sig.length / 2).toString(16).padStart(64, "0");
    const sigPadded = sig.length % 64 === 0 ? sig : sig + "0".repeat(64 - (sig.length % 64));
    // isValidSignature(bytes32 hash, bytes signature): selector + hash + offset(0x40) + len + data
    const data = ERC1271_MAGIC +
        h +
        "0000000000000000000000000000000000000000000000000000000000000040" +
        sigLen +
        sigPadded;
    let json;
    try {
        const res = await fetch(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: account, data }, "latest"] }),
        });
        json = await res.json();
    }
    catch {
        return false;
    }
    if (json.error || typeof json.result !== "string")
        return false;
    return json.result.toLowerCase().startsWith(ERC1271_MAGIC);
}
