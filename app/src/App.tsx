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
  forgetAccount,
  hasAccount,
  isLegacyDemo,
  knownAccounts,
  setActiveAccount,
  DEMO_ACCOUNT,
} from "./config";
import { Onboard } from "./screens/Onboard";

interface KnownRow {
  address: `0x${string}`;
  upId: string | null;
  verified: boolean;
}

/** Skill v2: there is no logout, there are accounts on this device. The
 *  identity card opens this switcher. Switching signs nothing. */
function AccountSwitcher({
  onClose,
  onSwitched,
  onAddAccount,
  onOpenAccount,
}: {
  onClose: () => void;
  onSwitched: () => void;
  onAddAccount: () => void;
  onOpenAccount: () => void;
}) {
  const [rows, setRows] = useState<KnownRow[] | null>(null);
  const current = activeAccount().toLowerCase();
  const hasDemo = knownAccounts().some((a) => a.toLowerCase() === DEMO_ACCOUNT.toLowerCase());

  const load = async () => {
    const list = knownAccounts();
    const out: KnownRow[] = [];
    for (const address of list) {
      try {
        const s = await api.status(address);
        out.push({ address, upId: s.upId, verified: s.isVerified });
      } catch {
        out.push({ address, upId: null, verified: false });
      }
    }
    setRows(out);
  };
  useEffect(() => {
    load();
  }, []);

  const remove = (address: string) => {
    const ok = window.confirm(
      "Forget this account on this device? The account itself lives on chain. Your passkey stays in this device's credential manager.",
    );
    if (!ok) return;
    forgetAccount(address);
    if (address.toLowerCase() === current) {
      const rest = knownAccounts();
      setActiveAccount(rest[0] ?? DEMO_ACCOUNT);
      onSwitched();
    }
    load();
  };

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Accounts" onClick={onClose}>
      <div className="l2 switcher" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 10px" }}>Accounts on this device</h2>
        {!rows ? (
          <div className="status-line">
            <Spinner /> loading…
          </div>
        ) : (
          rows.map((r) => {
            const isCurrent = r.address.toLowerCase() === current;
            return (
              <div className="switch-row" key={r.address}>
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
                  </span>
                  {isCurrent && <Check size={15} strokeWidth={2} color="var(--jade)" />}
                </button>
                <button className="switch-x" aria-label="Forget account" onClick={() => remove(r.address)}>
                  ×
                </button>
              </div>
            );
          })
        )}
        <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
          <button
            className="primary"
            onClick={() => {
              onClose();
              onAddAccount();
            }}
          >
            Add account
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
        </div>
      </div>
    </div>
  );
}
import { Seal, Spinner, fmtEth, shortAddr } from "./ui";
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
  const [error, setError] = useState<string | null>(null);
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
      setError(String(e));
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
    <div className="status-line">
      {!error && <Spinner />} {error ? `guardian unreachable: ${error}` : "connecting to guardian…"}
    </div>
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
