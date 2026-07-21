import { useEffect, useRef, useState } from "react";
import { isAddress, parseEther, type Hex } from "viem";
import { api, GuardianError, type Status } from "../api";
import { accountNonce, computeChallenge, watchReceipt, type Call } from "../chain";
import { assertWithPasskey } from "../webauthn";
import { DEMO_ACCOUNT, EXPLORER, LS_CREDENTIAL, OTP_THRESHOLD_WEI } from "../config";
import { Seal, Spinner, TileDivider, fmtEth, shortAddr } from "../ui";

interface Recipient {
  address: Hex;
  display: string;
  verified: boolean;
  verifiedBy: string | null;
  notFound?: boolean;
}

type SendPhase =
  | { k: "idle" }
  | { k: "signing" }
  | { k: "relaying" }
  | { k: "pending"; hash: Hex }
  | { k: "preconfirmed"; hash: Hex; ms: number }
  | { k: "final"; hash: Hex; ms: number; inclusionMs: number }
  | { k: "otp"; expiresAt: number; error?: string }
  | { k: "error"; message: string };

export function Send({ status, refresh }: { status: Status; refresh: () => void }) {
  const [input, setInput] = useState("");
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [resolving, setResolving] = useState(false);
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<SendPhase>({ k: "idle" });
  const [otpValue, setOtpValue] = useState("");
  const [countdown, setCountdown] = useState(0);
  const debounceRef = useRef<number>();

  // Live up.id resolution, 300ms debounce (spec §3 screen 2).
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    setRecipient(null);
    const q = input.trim();
    if (!q) return;
    debounceRef.current = window.setTimeout(async () => {
      setResolving(true);
      try {
        if (isAddress(q)) {
          const s = await api.status(q);
          setRecipient({
            address: q as Hex,
            display: s.upId ? `${s.upId}.up.id` : shortAddr(q),
            verified: s.isVerified,
            verifiedBy: s.verifiedBy,
          });
        } else {
          const r = await api.resolve(q);
          if (!r.address) {
            setRecipient({
              address: "0x0" as Hex, display: q, verified: false, verifiedBy: null, notFound: true,
            });
          } else {
            setRecipient({
              address: r.address,
              display: q.endsWith(".up.id") ? q : `${q}.up.id`,
              verified: r.verified,
              verifiedBy: r.verifiedBy,
            });
          }
        }
      } finally {
        setResolving(false);
      }
    }, 300);
  }, [input]);

  // OTP expiry countdown.
  useEffect(() => {
    if (phase.k !== "otp") return;
    const t = window.setInterval(() => {
      setCountdown(Math.max(0, phase.expiresAt - Math.floor(Date.now() / 1000)));
    }, 500);
    return () => window.clearInterval(t);
  }, [phase]);

  const doSend = async (otpCode: string) => {
    if (!recipient || recipient.notFound) return;
    const credentialId = localStorage.getItem(LS_CREDENTIAL);
    if (!credentialId) {
      setPhase({ k: "error", message: "No passkey linked on this device — visit Upgrade first." });
      return;
    }
    let value: bigint;
    try {
      value = parseEther(amount);
    } catch {
      setPhase({ k: "error", message: "Invalid amount." });
      return;
    }
    if (value > BigInt(status.balance)) {
      setPhase({ k: "error", message: "Insufficient balance." });
      return;
    }
    try {
      setPhase({ k: "signing" });
      const calls: Call[] = [{ target: recipient.address, value, data: "0x" }];
      const nonce = await accountNonce(DEMO_ACCOUNT);
      const challenge = computeChallenge(DEMO_ACCOUNT, nonce, calls);
      const webauthn = await assertWithPasskey(credentialId, challenge);
      setPhase({ k: "relaying" });
      const t0 = performance.now();
      const { txHash } = await api.relay(
        DEMO_ACCOUNT,
        calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })),
        otpCode,
        webauthn,
      );
      setPhase({ k: "pending", hash: txHash });
      const timing = await watchReceipt(txHash, t0);
      setPhase({ k: "preconfirmed", hash: txHash, ms: timing.preconfMs });
      setPhase({ k: "final", hash: txHash, ms: timing.preconfMs, inclusionMs: timing.inclusionMs });
      refresh();
    } catch (e) {
      if (e instanceof GuardianError && e.message === "OtpRequired") {
        // Screen 3: OTP interstitial — request a code bound to this exact transfer.
        try {
          const r = await api.otpRequest(DEMO_ACCOUNT, recipient.address, value.toString());
          setOtpValue("");
          setPhase({ k: "otp", expiresAt: r.expiresAt });
        } catch (e2) {
          setPhase({ k: "error", message: String(e2) });
        }
      } else if (e instanceof GuardianError && phase.k === "otp") {
        setPhase({ ...phase, error: e.message });
      } else if (e instanceof GuardianError) {
        setPhase({ k: "error", message: e.message });
      } else {
        setPhase({ k: "error", message: String(e) });
      }
    }
  };

  const value = (() => {
    try { return parseEther(amount || "0"); } catch { return 0n; }
  })();
  const willWarn = recipient && !recipient.notFound && !recipient.verified;
  const willOtp = willWarn && value >= OTP_THRESHOLD_WEI;

  return (
    <div>
      <div className="card">
        <h2>
          {status.upId ? `${status.upId}.up.id` : shortAddr(status.address)}{" "}
          {status.isVerified && <Seal small />}
        </h2>
        <div className="balance">
          {fmtEth(status.balance)} <small>ETH</small>
        </div>
        <div className="muted">Flashblocks-fresh · smart account · nonce {status.accountNonce}</div>
      </div>

      <TileDivider />

      <div className="card">
        <h2>Send</h2>
        <input
          type="text"
          placeholder="Recipient — name or 0x address"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        {resolving && (
          <div className="status-line">
            <Spinner /> resolving…
          </div>
        )}
        {recipient && recipient.notFound && (
          <div className="warnbox">No active up.id named “{recipient.display}”.</div>
        )}
        {recipient && !recipient.notFound && (
          <div className={`recipient-card ${recipient.verified ? "verified" : "unverified"}`}>
            {recipient.verified ? <Seal small /> : <span style={{ fontSize: "1.2rem" }}>⚠️</span>}
            <div>
              <div className="name">{recipient.display}</div>
              <div className="muted mono">{recipient.address}</div>
              {recipient.verified ? (
                <div className="okbox">Verified by {recipient.verifiedBy}</div>
              ) : (
                <div className="warnbox">
                  Unverified address — Suho can’t identify who this is.
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <input
            type="text"
            placeholder="Amount (ETH)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        {willOtp && (
          <div className="warnbox">
            Large transfer to an unverified address — a verification code will be required.
          </div>
        )}

        <button
          className="primary"
          disabled={
            !recipient || recipient.notFound || !amount ||
            phase.k === "signing" || phase.k === "relaying" || phase.k === "pending"
          }
          onClick={() => doSend("")}
        >
          Send
        </button>

        {phase.k === "signing" && (
          <div className="status-line"><Spinner /> Confirm with your passkey…</div>
        )}
        {phase.k === "relaying" && (
          <div className="status-line"><Spinner /> Relaying to GIWA…</div>
        )}
        {phase.k === "pending" && (
          <div className="status-line">
            <Spinner /> Pending — <a href={`${EXPLORER}/tx/${phase.hash}`} target="_blank">{shortAddr(phase.hash)}</a>
          </div>
        )}
        {(phase.k === "preconfirmed" || phase.k === "final") && (
          <div className="okbox">
            ✓ Confirmed in <span className="timing">{phase.ms}ms</span>
            {phase.k === "final" && phase.inclusionMs > 0 && (
              <span className="muted"> (block inclusion {phase.inclusionMs}ms)</span>
            )}{" "}
            · <a href={`${EXPLORER}/tx/${phase.hash}`} target="_blank">explorer</a>
          </div>
        )}
        {phase.k === "error" && <div className="errbox">{phase.message}</div>}
      </div>

      {phase.k === "otp" && (
        <div className="card">
          <h2>Verification required</h2>
          <p className="muted">
            This is a large transfer to an unverified address. Enter the verification code sent to
            you.
          </p>
          <input
            type="text"
            className="otp-input"
            maxLength={6}
            value={otpValue}
            inputMode="numeric"
            onChange={(e) => setOtpValue(e.target.value.replace(/\D/g, ""))}
          />
          <div className="countdown">
            {countdown > 0
              ? `code expires in ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, "0")}`
              : "code expired — request a new one by sending again"}
          </div>
          {phase.error && <div className="errbox">{phase.error}</div>}
          <button
            className="primary"
            disabled={otpValue.length !== 6 || countdown === 0}
            onClick={() => doSend(otpValue)}
          >
            Verify & send
          </button>
        </div>
      )}
    </div>
  );
}
