import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSignature, type Hex } from "viem";
import { api } from "../api";
import {
  ARISE_ADDRESS,
  DEMO_ACCOUNT,
  EXPLORER,
  GUARD_ADDRESS,
  storeCredential,
  ONDOL_V2_IMPL,
  setActiveAccount,
} from "../config";
import { createPasskey } from "../webauthn";
import { humanError, isUserCancel } from "../errors";
import { Seal, Spinner, shortAddr } from "../ui";
import { useToast } from "../toast";

type Stage =
  | { k: "intro" }
  | { k: "working"; note: string }
  | { k: "done"; address: Hex; txHash: Hex }
  | { k: "error"; message: string };

interface Bootstrap {
  address: Hex;
  sign(passkey: { x: Hex; y: Hex }): Promise<{
    authorization: { address: Hex; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number };
    initSig: { v: number; r: Hex; s: Hex };
  }>;
}

/**
 * The bootstrap key is generated HERE so its ADDRESS is known before the
 * passkey is created (the passkey is then labelled with that address). The key
 * lives only in this closure across the passkey-creation await, is used for
 * exactly two signatures, and every reference is dropped in sign():
 *   - never in React state, never rendered, never logged
 *   - never in localStorage/sessionStorage/IndexedDB/cookies
 *   - never sent over the network. Only the SIGNATURES travel.
 * See README for the 7702 root-key threat model.
 */
function makeBootstrap(): Bootstrap {
  let pk: Hex | null = generatePrivateKey();
  let eoa: ReturnType<typeof privateKeyToAccount> | null = privateKeyToAccount(pk);
  const address = eoa.address;
  return {
    address,
    async sign(passkey) {
      const acct = eoa!;
      // signature 1: 7702 authorization (nonce 0, fresh EOA, relayer submits)
      const auth = await acct.signAuthorization({
        contractAddress: ONDOL_V2_IMPL,
        chainId: 91342,
        nonce: 0,
      });
      // signature 2: EIP-712 digest authorizing the first passkey
      const sig = await acct.signTypedData({
        domain: { name: "Suho Ondol", version: "2", chainId: 91342, verifyingContract: address },
        types: {
          Init: [
            { name: "x", type: "bytes32" },
            { name: "y", type: "bytes32" },
            { name: "guard", type: "address" },
            { name: "arise", type: "address" },
          ],
        },
        primaryType: "Init",
        message: { x: passkey.x, y: passkey.y, guard: GUARD_ADDRESS, arise: ARISE_ADDRESS },
      });
      const parsed = parseSignature(sig);
      pk = null;
      eoa = null; // key's job is done, drop every reference
      return {
        authorization: {
          address: auth.address ?? ONDOL_V2_IMPL,
          chainId: 91342,
          nonce: 0,
          r: auth.r,
          s: auth.s,
          yParity: auth.yParity ?? 0,
        },
        initSig: { v: Number(parsed.v ?? BigInt(27 + (parsed.yParity ?? 0))), r: parsed.r, s: parsed.s },
      };
    },
  };
}

export function Onboard({
  onDone,
  onLegacy,
  paused = false,
}: {
  onDone: () => void;
  onLegacy: () => void;
  paused?: boolean;
}) {
  const [stage, setStage] = useState<Stage>({ k: "intro" });
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const copyAddress = async (address: string) => {
    await navigator.clipboard.writeText(address).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const create = async () => {
    try {
      // Bootstrap first so the passkey can be labelled with the account address.
      const boot = makeBootstrap();
      const address = boot.address;

      setStage({ k: "working", note: "Creating your passkey. No seed phrase exists." });
      // user.name = the FULL address, so the device credential manager itself is
      // an address backup (a fresh account has no up.id yet). displayName stays
      // short for readability in the OS chooser.
      const passkey = await createPasskey(address, `suho ${shortAddr(address)}`);
      storeCredential(address, passkey.credentialId);

      setStage({ k: "working", note: "Preparing your account…" });
      const { authorization, initSig } = await boot.sign({ x: passkey.x, y: passkey.y });

      setStage({ k: "working", note: "Activating on GIWA. The guardian pays the gas…" });
      const r = await api.onboard({
        address,
        authorization,
        initSig,
        passkey: { x: passkey.x, y: passkey.y },
      });
      if (r.status !== "success" || !r.initialized) {
        throw new Error(`onboarding tx ${r.status}; initialized=${r.initialized}`);
      }
      setActiveAccount(address);
      setStage({ k: "done", address, txHash: r.txHash });
    } catch (e) {
      if (isUserCancel(e)) {
        setStage({ k: "intro" });
        toast.note("Canceled.");
      } else {
        setStage({ k: "error", message: humanError(e).text });
      }
    }
  };

  return (
    <div className="main">
      <div className="content" style={{ maxWidth: 560, paddingTop: 40 }}>
        <div className="screen-head center">
          <p className="eyebrow">
            <span className="ko" lang="ko">지붕 아래</span> · UNDER THE ROOF
          </p>
          <h1 className="screen-title">
            Suho <span style={{ color: "var(--seal)" }}>수호</span>
          </h1>
        </div>

        {stage.k === "intro" && (
          <div className="card center">
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
              <Seal large />
            </div>
            <div className="hero">A wallet that guards you.</div>
            <p className="muted">
              A passkey account on GIWA. No seed phrase, no gas to start.
            </p>
            {paused && (
              <div className="status-banner" role="status" style={{ marginBottom: 12 }}>
                New account creation is paused. The demo relayer needs a top-up.
              </div>
            )}
            <button className="primary wide" onClick={create} disabled={paused}>
              Create your Suho account
            </button>
            <button className="secondary" onClick={onLegacy} style={{ fontSize: "0.8rem" }}>
              I have the demo account
            </button>
          </div>
        )}

        {stage.k === "working" && (
          <div className="card center">
            <div className="status-line" style={{ justifyContent: "center" }}>
              <Spinner /> {stage.note}
            </div>
          </div>
        )}

        {stage.k === "done" && (
          <div className="card center">
            <div className="big-check">✓</div>
            <div className="hero">Your account exists.</div>
            <p className="muted">
              Not yet verified, balance 0. The guided steps on your home screen finish the setup.
            </p>

            <div className="save-address">
              <div className="save-address-label">Your account address</div>
              <button
                className="address-xl mono"
                onClick={() => copyAddress(stage.address)}
                title="Copy address"
              >
                <span>{stage.address}</span>
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
              <p className="save-address-note">
                Save this address. Your passkey stays on this device, but if you clear browser
                data you will need the address to add the account back.
              </p>
            </div>

            <label className="ack">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              <span>I have saved this address.</span>
            </label>

            <p className="mono muted">
              <a href={`${EXPLORER}/tx/${stage.txHash}`} target="_blank" rel="noreferrer">
                activation tx {shortAddr(stage.txHash)}
              </a>
            </p>
            <hr className="hairline" />
            <button className="primary wide" onClick={onDone} disabled={!saved}>
              Enter Suho
            </button>
          </div>
        )}

        {stage.k === "error" && (
          <div className="card center">
            <div className="errbox">{stage.message}</div>
            <button className="secondary" onClick={() => setStage({ k: "intro" })}>
              Try again
            </button>
          </div>
        )}

        <p className="muted center" style={{ fontSize: "0.75rem", marginTop: 18 }}>
          Demo account ({shortAddr(DEMO_ACCOUNT)}) remains available via the legacy path.
        </p>
      </div>
    </div>
  );
}
