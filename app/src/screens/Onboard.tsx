import { useState } from "react";
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
import { Seal, Spinner, TileDivider, shortAddr } from "../ui";

type Stage =
  | { k: "intro" }
  | { k: "working"; note: string }
  | { k: "done"; address: Hex; txHash: Hex }
  | { k: "error"; message: string };

/**
 * Phase O §O5 step 2 — the ONE-TIME BOOTSTRAP KEY.
 *
 * EIP-7702 needs a secp256k1 signature to authorize the delegation and the
 * first passkey. We generate that key HERE, in this function's scope, use it
 * for exactly two signatures, and let it go out of scope:
 *   - it is never put in React state, never rendered, never logged
 *   - it is never written to localStorage/sessionStorage/IndexedDB/cookies
 *   - it is never sent over the network — only the SIGNATURES travel
 * After onboarding the passkey is the sole practical authority; the discarded
 * bootstrap key is unrecoverable by anyone, including us (see README threat
 * model for the 7702 root-key honesty note).
 */
async function bootstrapSignatures(passkey: { x: Hex; y: Hex }): Promise<{
  address: Hex;
  authorization: { address: Hex; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number };
  initSig: { v: number; r: Hex; s: Hex };
}> {
  let pk: Hex | null = generatePrivateKey();
  let eoa: ReturnType<typeof privateKeyToAccount> | null = privateKeyToAccount(pk);
  const address = eoa.address;

  // signature 1: the 7702 authorization (nonce 0 — fresh EOA, relayer submits)
  const auth = await eoa.signAuthorization({
    contractAddress: ONDOL_V2_IMPL,
    chainId: 91342,
    nonce: 0,
  });

  // signature 2: EIP-712 digest authorizing the first passkey (OndolAccountV2)
  const sig = await eoa.signTypedData({
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

  // the key's job is done — drop every reference before returning
  pk = null;
  eoa = null;

  return {
    address,
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
}

export function Onboard({
  onDone,
  onLegacy,
}: {
  onDone: () => void;
  onLegacy: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ k: "intro" });

  const create = async () => {
    try {
      setStage({ k: "working", note: "Creating your passkey. No seed phrase exists." });
      const passkey = await createPasskey("suho account");

      setStage({ k: "working", note: "Preparing your account…" });
      const { address, authorization, initSig } = await bootstrapSignatures({
        x: passkey.x,
        y: passkey.y,
      });
      storeCredential(address, passkey.credentialId);

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
      setStage({ k: "error", message: String(e) });
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
            <button className="primary wide" onClick={create}>
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
            <p className="mono muted">{stage.address}</p>
            <p className="muted">
              Not yet verified, balance 0. The guided steps on your home screen finish the setup.
            </p>
            <p className="mono muted">
              <a href={`${EXPLORER}/tx/${stage.txHash}`} target="_blank" rel="noreferrer">
                activation tx {shortAddr(stage.txHash)}
              </a>
            </p>
            <TileDivider />
            <button className="primary wide" onClick={onDone}>
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
