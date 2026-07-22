import { useCallback, useEffect, useState } from "react";
import {
  SendHorizontal,
  BookUser,
  IdCard,
  KeyRound,
  Check,
  Copy,
  type LucideIcon,
} from "lucide-react";
import { api, type Status } from "./api";
import {
  activeAccount,
  credentialFor,
  forgetAccount,
  hasAccount,
  isLegacyDemo,
  knownAccounts,
  rememberAccount,
  setActiveAccount,
  storeCredential,
  DEMO_ACCOUNT,
} from "./config";
import { accountPasskey, isOndolAccount } from "./chain";
import { relinkPasskey } from "./webauthn";
import { Onboard } from "./screens/Onboard";

interface KnownRow {
  address: `0x${string}`;
  upId: string | null;
  verified: boolean;
  credentialId: string | null;
}

/** Skill v2: there is no logout, there are accounts on this device. The
 *  identity card opens this switcher. Switching signs nothing; it just changes
 *  which account is active. Linking is a one-time re-attach of a passkey
 *  already on this device. Arise is only for a genuinely lost key. */
function AccountSwitcher({
  onClose,
  onSwitched,
  onAddAccount,
  onOpenAccount,
  onRecover,
}: {
  onClose: () => void;
  onSwitched: () => void;
  onAddAccount: () => void;
  onOpenAccount: () => void;
  onRecover: (address: `0x${string}`) => void;
}) {
  const [rows, setRows] = useState<KnownRow[] | null>(null);
  const [linkErr, setLinkErr] = useState<Record<string, string>>({});
  const [linking, setLinking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addr, setAddr] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const current = activeAccount().toLowerCase();
  const hasDemo = knownAccounts().some((a) => a.toLowerCase() === DEMO_ACCOUNT.toLowerCase());

  const load = async () => {
    const list = knownAccounts();
    const out: KnownRow[] = [];
    for (const address of list) {
      try {
        const s = await api.status(address);
        out.push({ address, upId: s.upId, verified: s.isVerified, credentialId: credentialFor(address) });
      } catch {
        out.push({ address, upId: null, verified: false, credentialId: credentialFor(address) });
      }
    }
    setRows(out);
  };
  useEffect(() => {
    load();
  }, []);

  /** Chain-verified relink: user picks a passkey; it is stored only if its
   *  signature verifies against the account's on-chain P-256 key. */
  const link = async (address: `0x${string}`) => {
    setLinking(address);
    setLinkErr((m) => ({ ...m, [address]: "" }));
    try {
      const expected = await accountPasskey(address);
      const credentialId = await relinkPasskey(expected);
      storeCredential(address, credentialId);
      await load();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // A cancelled/absent prompt (NotAllowedError) or a key that verifies
      // against a different account both mean the same thing to the user: the
      // right passkey isn't on this device. Offer Arise.
      const msg =
        e instanceof DOMException || /timed out|not allowed|NotAllowed/i.test(raw)
          ? "No matching passkey on this device."
          : raw.startsWith("That passkey")
            ? raw
            : "Couldn't link a passkey to this account.";
      setLinkErr((m) => ({ ...m, [address]: msg }));
    } finally {
      setLinking(null);
    }
  };

  /** Add existing account: validate it is one of our Ondol accounts on chain,
   *  register it, then run the relink. Works from a fully cleared cache
   *  because everything is reconstructed from chain plus a passkey pick. */
  const addExisting = async () => {
    const a = addr.trim();
    setAddErr(null);
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
      setAddErr("Enter a valid 0x address.");
      return;
    }
    if (knownAccounts().some((k) => k.toLowerCase() === a.toLowerCase())) {
      setAddErr("That account is already on this device.");
      return;
    }
    setAddBusy(true);
    try {
      let ondol: boolean;
      try {
        ondol = await isOndolAccount(a as `0x${string}`);
      } catch {
        setAddErr("Couldn't reach GIWA to check that address. Try again.");
        return;
      }
      if (!ondol) {
        setAddErr("That address is not a Suho account on GIWA.");
        return;
      }
      rememberAccount(a);
      setAdding(false);
      setAddr("");
      await load();
      await link(a as `0x${string}`); // straight into the passkey pick
    } finally {
      setAddBusy(false);
    }
  };

  const remove = (address: string) => {
    const ok = window.confirm(
      "Forget this account on this device? The account itself lives on chain. Your passkey stays in this device's credential manager.",
    );
    if (!ok) return;
    forgetAccount(address);
    if (address.toLowerCase() === current) {
      const rest = knownAccounts().filter((a) => a.toLowerCase() !== address.toLowerCase());
      setActiveAccount(rest[0] ?? DEMO_ACCOUNT);
      onSwitched();
    }
    load();
  };

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Accounts" onClick={onClose}>
      <div className="l2 switcher" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 4px" }}>Accounts on this device</h2>
        <p className="muted" style={{ margin: "0 0 12px", fontSize: "0.8rem" }}>
          Switching just changes the active account. It signs nothing.
        </p>
        {!rows ? (
          <div className="status-line">
            <Spinner /> loading…
          </div>
        ) : (
          rows.map((r) => {
            const isCurrent = r.address.toLowerCase() === current;
            const err = linkErr[r.address];
            return (
              <div key={r.address}>
                <div className="switch-row">
                  <button
                    className="switch-main"
                    onClick={() => {
                      if (isCurrent) {
                        onOpenAccount();
                      } else {
                        setActiveAccount(r.address);
                        onSwitched();
                      }
                      onClose();
                    }}
                  >
                    {r.verified ? <Seal small /> : <span className="gray-dot" aria-label="Unverified" />}
                    <span className="switch-name">
                      {r.upId ? `${r.upId}.up.id` : shortAddr(r.address)}
                      {r.address.toLowerCase() === DEMO_ACCOUNT.toLowerCase() && (
                        <span className="demo-tag">demo</span>
                      )}
                      <span className="cred-line">
                        {r.credentialId ? `key ${r.credentialId.slice(0, 8)}…` : "no key on this device"}
                      </span>
                    </span>
                    {isCurrent && <Check size={15} strokeWidth={2} color="var(--jade)" />}
                  </button>
                  {!r.credentialId && (
                    <button
                      className="switch-link"
                      disabled={linking !== null}
                      onClick={() => link(r.address)}
                    >
                      {linking === r.address ? "…" : "Link"}
                    </button>
                  )}
                  <button className="switch-x" aria-label="Forget account" onClick={() => remove(r.address)}>
                    ×
                  </button>
                </div>
                {!r.credentialId && err && (
                  <div className="link-fallback">
                    <span className="errbox" style={{ margin: 0 }}>{err}</span>
                    <button className="switch-link" onClick={() => onRecover(r.address)}>
                      Recover with Arise
                    </button>
                  </div>
                )}
                {!r.credentialId && !err && (
                  <div className="cred-hint">
                    Link re-attaches a passkey already on this device. One time, signs nothing.
                  </div>
                )}
              </div>
            );
          })
        )}

        <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
          {adding ? (
            <div className="add-existing">
              <input
                type="text"
                placeholder="0x address of your Suho account"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                aria-label="Account address"
              />
              {addErr && <div className="errbox">{addErr}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button className="primary" style={{ flex: 1 }} disabled={addBusy} onClick={addExisting}>
                  {addBusy ? "Checking…" : "Find & link"}
                </button>
                <button className="secondary" style={{ margin: 0 }} onClick={() => { setAdding(false); setAddErr(null); }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                className="primary"
                onClick={() => {
                  onClose();
                  onAddAccount();
                }}
              >
                Add account
              </button>
              <button className="secondary" onClick={() => setAdding(true)}>
                Add existing account
              </button>
              {!hasDemo && (
                <button
                  className="secondary"
                  onClick={() => {
                    setActiveAccount(DEMO_ACCOUNT);
                    onSwitched();
                    onClose();
                  }}
                >
                  Use demo account
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
import { ErrNote, Seal, Spinner, fmtEth, shortAddr } from "./ui";
import { Upgrade } from "./screens/Upgrade";
import { Send } from "./screens/Send";
import { Arise } from "./screens/Arise";
import { Directory } from "./screens/Directory";
import { Card } from "./screens/Card";
import { Verify } from "./screens/Verify";

type Screen = "upgrade" | "send" | "directory" | "card" | "arise";

const NAV: { key: Screen; label: string; icon: LucideIcon }[] = [
  { key: "send", label: "Send", icon: SendHorizontal },
  { key: "directory", label: "Directory", icon: BookUser },
  { key: "card", label: "Card", icon: IdCard },
  { key: "arise", label: "Arise", icon: KeyRound },
];

/** Sidebar identity block: seal, name, copyable address, balance, attestation.
 *  Clicking it opens the Account/Upgrade screen (not in the main nav). */
function IdentityCard({ status, onOpen }: { status: Status; onOpen: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(status.address).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div
      className="id-card"
      role="button"
      tabIndex={0}
      title="Account & upgrade"
      style={{ cursor: "pointer" }}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
    >
      <div className="id-top">
        {status.isVerified && <Seal small />}
        <div>
          <div className="id-name">{status.upId ? `${status.upId}.up.id` : "Suho account"}</div>
          <button
            className="id-addr"
            onClick={(e) => {
              e.stopPropagation();
              copy();
            }}
            title="Copy address"
          >
            {shortAddr(status.address)} {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </div>
      </div>
      <div className="id-balance">
        {fmtEth(status.balance)} <small>ETH</small>
      </div>
      {status.isVerified && (
        <div className="attestation-note" title={`Attester: ${status.verifiedBy}`}>
          Dojang attestation · testnet issuer
        </div>
      )}
      {isLegacyDemo() &&
        (status.demoReady === false ? (
          <span className="chip-warn">⚠ Demo headroom low</span>
        ) : (
          <span className="chip-ok">Demo ready</span>
        ))}
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("upgrade");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [prefillRecipient, setPrefillRecipient] = useState<string | null>(null);
  const [verifyId, setVerifyId] = useState<string | null>(null);
  const [onboarded, setOnboarded] = useState(() => hasAccount());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);

  const switchRefresh = useCallback(() => {
    setStatus(null);
    setScreen("send");
    refresh();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api.status(activeAccount());
      // first-run routing: an already-upgraded account lands on Send, not Upgrade
      setStatus((prev) => {
        if (prev === null && s.isOndolAccount && s.initialized) setScreen("send");
        return s;
      });
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // C5: hash route #/verify/<address-or-uid> — shareable read-only view.
  useEffect(() => {
    const readHash = () => {
      const m = window.location.hash.match(/^#\/verify\/(.+)$/);
      setVerifyId(m ? m[1] : null);
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  if (verifyId) {
    return (
      <div className="main">
        <div className="content" style={{ maxWidth: 560 }}>
          <div className="screen-head">
            <p className="eyebrow">VERIFICATION VIEW</p>
            <h1 className="screen-title">
              Suho <span style={{ color: "var(--seal)" }}>수호</span>
            </h1>
          </div>
          <Verify id={verifyId} />
        </div>
      </div>
    );
  }

  // Phase O §O5: fresh browsers meet onboarding first; the demo account is the
  // clearly-labeled legacy path. "Add account" from the switcher re-enters it.
  if (!onboarded || addingAccount) {
    return (
      <Onboard
        onDone={() => {
          setStatus(null);
          setOnboarded(true);
          setAddingAccount(false);
          setScreen("send");
          refresh();
        }}
        onLegacy={() => {
          setActiveAccount(DEMO_ACCOUNT);
          setStatus(null);
          setOnboarded(true);
          setAddingAccount(false);
          setScreen("upgrade");
          refresh();
        }}
      />
    );
  }

  const nav = (key: Screen) => setScreen(key);
  const body = !status ? (
    error ? (
      <ErrNote error={error} />
    ) : (
      <div className="status-line">
        <Spinner /> connecting to guardian…
      </div>
    )
  ) : (
    <>
      {screen === "upgrade" && <Upgrade status={status} onDone={() => setScreen("send")} />}
      {screen === "send" && (
        <Send status={status} refresh={refresh} prefillRecipient={prefillRecipient} />
      )}
      {screen === "directory" && (
        <Directory
          onSendTo={(name) => {
            setPrefillRecipient(name);
            setScreen("send");
          }}
        />
      )}
      {screen === "card" && <Card status={status} />}
      {screen === "arise" && <Arise status={status} refresh={refresh} />}
    </>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="wordmark">
          Suho<span className="hanja">수호</span>
        </div>
        {status && <IdentityCard status={status} onOpen={() => setSwitcherOpen(true)} />}
        <nav className="nav" aria-label="Screens">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav-item${screen === n.key ? " active" : ""}`}
              onClick={() => nav(n.key)}
            >
              <n.icon size={18} strokeWidth={1.5} />
              {n.label}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <span className="net-pill">
            <span className="dot" /> GIWA Sepolia · ~0.9s preconf
          </span>
          <span className="guardian-status">
            <span className={`dot${error ? " err" : ""}`} />
            {error ? "guardian offline" : "guardian connected"}
          </span>
        </div>
      </aside>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="topbar-m">
          <div className="wordmark" style={{ padding: 0 }}>
            Suho<span className="hanja">수호</span>
          </div>
          {status && (
            <button
              className="bal"
              style={{ background: "none", border: 0, color: "inherit", cursor: "pointer" }}
              onClick={() => setSwitcherOpen(true)}
              title="Accounts"
            >
              {fmtEth(status.balance)} ETH
            </button>
          )}
        </div>
        <main className="main">
          <div className="content">{body}</div>
        </main>
      </div>

      {switcherOpen && (
        <AccountSwitcher
          onClose={() => setSwitcherOpen(false)}
          onSwitched={switchRefresh}
          onAddAccount={() => setAddingAccount(true)}
          onOpenAccount={() => setScreen("upgrade")}
          onRecover={(address) => {
            // No passkey on this device matches. Switch to the account and run
            // Arise to rotate in a fresh passkey.
            setActiveAccount(address);
            setStatus(null);
            setScreen("arise");
            setSwitcherOpen(false);
            refresh();
          }}
        />
      )}

      <nav className="tabbar" aria-label="Screens">
        {NAV.map((n) => (
          <button
            key={n.key}
            className={`tab-item${screen === n.key ? " active" : ""}`}
            onClick={() => nav(n.key)}
          >
            <n.icon size={18} strokeWidth={1.5} />
            {n.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
