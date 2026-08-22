import { useCallback, useEffect, useRef, useState } from "react";
import { isAddress, type Hex } from "viem";
import {
  SendHorizontal,
  BookUser,
  IdCard,
  KeyRound,
  Gauge,
  ScrollText,
  Check,
  Copy,
  Download,
  Upload,
  BookOpen,
  ChevronDown,
  Search,
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
  SHOW_DEMO,
  DOCS_URL,
  GITHUB_URL,
  LANDING_URL,
} from "./config";
import { accountPasskey, isOndolAccount } from "./chain";
import { relinkPasskey } from "./webauthn";
import { humanError } from "./errors";
import { lockMessages } from "./messages";
import { cachedStatus, peekStatus } from "./api";
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
  const [ioMsg, setIoMsg] = useState<string | null>(null);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const current = activeAccount()?.toLowerCase() ?? "";
  const hasDemo = knownAccounts().some((a) => a.toLowerCase() === DEMO_ACCOUNT.toLowerCase());

  const load = async () => {
    const list = knownAccounts();
    // 1) Paint instantly from local data + any cached status — no waiting on RPC.
    setRows(
      list.map((address) => {
        const cached = peekStatus(address);
        return {
          address,
          upId: cached?.upId ?? null,
          verified: cached?.isVerified ?? false,
          credentialId: credentialFor(address),
        };
      }),
    );
    // 2) Refresh statuses in PARALLEL (was a serial per-account loop over the
    //    rate-limited RPC — the reason the list was slow to appear).
    const fresh = await Promise.all(
      list.map(async (address) => {
        try {
          const s = await cachedStatus(address);
          return { address, upId: s.upId, verified: s.isVerified, credentialId: credentialFor(address) };
        } catch {
          return { address, upId: null, verified: false, credentialId: credentialFor(address) };
        }
      }),
    );
    setRows(fresh);
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

  /** Copy the full account address to the clipboard, with a brief tick. */
  const copyAddr = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddr(address);
      window.setTimeout(() => setCopiedAddr((c) => (c === address ? null : c)), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  const remove = (address: string) => {
    const ok = window.confirm(
      "Forget this account on this device? The account itself lives on chain. Your passkey stays in this device's credential manager. Save the address first if you want it back.",
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

  /** Export the account LIST — addresses and up.id names only. No key material
   *  exists to export: passkeys never leave the device credential manager and no
   *  private key is ever stored. This file is a recovery aid, not a secret. */
  const exportAccounts = () => {
    const accounts = (rows ?? knownAccounts().map((address) => ({ address, upId: null }))).map(
      (r) => ({ address: r.address, name: r.upId ? `${r.upId}.up.id` : null }),
    );
    const blob = new Blob(
      [JSON.stringify({ suho: "accounts", version: 1, note: "addresses only, no keys", accounts }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "suho-accounts.json";
    a.click();
    URL.revokeObjectURL(url);
    setIoMsg(`Exported ${accounts.length} account${accounts.length === 1 ? "" : "s"}.`);
  };

  /** Import restores the LIST only. Each imported row lands with no credential,
   *  so the row still shows Link and requires the chain-verified relink before it
   *  can sign. Importing never grants signing authority. */
  const importAccounts = async (file: File) => {
    setIoMsg(null);
    try {
      const parsed = JSON.parse(await file.text());
      const list: unknown[] = Array.isArray(parsed) ? parsed : parsed?.accounts;
      if (!Array.isArray(list)) throw new Error("shape");
      let added = 0;
      for (const item of list) {
        const a = typeof item === "string" ? item : (item as { address?: unknown })?.address;
        if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) {
          if (!knownAccounts().some((k) => k.toLowerCase() === a.toLowerCase())) {
            rememberAccount(a);
            added++;
          }
        }
      }
      await load();
      setIoMsg(
        added === 0
          ? "No new accounts to add. Each still needs Link to sign."
          : `Added ${added} account${added === 1 ? "" : "s"}. Use Link on each to attach its passkey.`,
      );
    } catch {
      setIoMsg("Couldn't read that accounts file.");
    }
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
                      {SHOW_DEMO && r.address.toLowerCase() === DEMO_ACCOUNT.toLowerCase() && (
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
                  <button
                    className={`switch-copy${copiedAddr === r.address ? " copied" : ""}`}
                    aria-label={copiedAddr === r.address ? "Address copied" : "Copy address"}
                    title="Copy address"
                    onClick={() => copyAddr(r.address)}
                  >
                    {copiedAddr === r.address ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
                  </button>
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
              {SHOW_DEMO && !hasDemo && (
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

        <div className="switch-io">
          <button className="io-link" onClick={exportAccounts}>
            <Download size={13} strokeWidth={1.5} /> Export accounts
          </button>
          <button className="io-link" onClick={() => importRef.current?.click()}>
            <Upload size={13} strokeWidth={1.5} /> Import accounts
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importAccounts(f);
              e.target.value = "";
            }}
          />
        </div>
        <p className="switch-io-note">
          Addresses and names only. No key material is exported. Imported accounts still need Link.
        </p>
        {ioMsg && <div className="okbox" style={{ marginTop: 4 }}>{ioMsg}</div>}
      </div>
    </div>
  );
}
import { ErrNote, GithubMark, Seal, Spinner, fmtEth, shortAddr } from "./ui";
import { Upgrade } from "./screens/Upgrade";
import { Send } from "./screens/Send";
import { Activity } from "./screens/Activity";
import { useMessages } from "./screens/Messages";
import { Limits } from "./screens/Limits";
import { Arise } from "./screens/Arise";
import { Directory } from "./screens/Directory";
import { Card } from "./screens/Card";
import { Verify } from "./screens/Verify";
import { Connect } from "./screens/Connect";

type Screen = "upgrade" | "send" | "activity" | "directory" | "card" | "arise" | "limits";

const NAV: { key: Screen; label: string; icon: LucideIcon }[] = [
  { key: "send", label: "Send", icon: SendHorizontal },
  { key: "activity", label: "Activity", icon: ScrollText },
  { key: "directory", label: "Directory", icon: BookUser },
  { key: "card", label: "Card", icon: IdCard },
  { key: "arise", label: "Arise", icon: KeyRound },
  { key: "limits", label: "Limits", icon: Gauge },
];


/** Shown when the active account exists on this device but has no passkey linked
 *  here (e.g. the demo account selected in production, or an imported account not
 *  yet linked). Replaces the old raw "No passkey linked… Visit Upgrade first"
 *  dead-end with a clear way out: switch, or create. */
function NeedsLink({
  status,
  isDemo,
  onLinkDemo,
  onManage,
  onCreate,
}: {
  status: Status;
  isDemo: boolean;
  onLinkDemo: () => void;
  onManage: () => void;
  onCreate: () => void;
}) {
  return (
    <div>
      <div className="screen-head">
        <p className="eyebrow">PASSKEY NEEDED</p>
        <h1 className="screen-title">Link a passkey</h1>
      </div>
      <div className="card center">
        <div className="hero">This account isn't linked on this device.</div>
        <p className="muted">
          {status.upId ? `${status.upId}.up.id` : shortAddr(status.address)} has no passkey here, so
          it can't sign. Switch to an account you control, or create a new one.
        </p>
        {isDemo && SHOW_DEMO && (
          <button className="secondary wide" onClick={onLinkDemo}>
            Link the demo passkey
          </button>
        )}
        <button className="primary wide" onClick={onManage}>
          Switch or add an account
        </button>
        <button className="secondary" onClick={onCreate}>
          Create a new account
        </button>
      </div>
    </div>
  );
}

/** Global top-bar search. Resolves a up.id name or 0x address to a recipient,
 *  DEBOUNCED (300ms) and CACHED per query, so typing never fires an RPC per
 *  keystroke. A match routes into a prefilled Send. */
type SearchHit = { address: Hex | null; upId: string | null; verified: boolean };
const searchCache = new Map<string, SearchHit>();

function GlobalSearch({ onSendTo }: { onSendTo: (q: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hit, setHit] = useState<SearchHit | "loading" | null>(null);
  const debounce = useRef<number>();

  useEffect(() => {
    window.clearTimeout(debounce.current);
    const query = q.trim();
    if (!query) {
      setHit(null);
      setOpen(false);
      return;
    }
    setOpen(true);
    const cached = searchCache.get(query.toLowerCase());
    if (cached) {
      setHit(cached);
      return; // cache hit: zero network
    }
    setHit("loading");
    debounce.current = window.setTimeout(async () => {
      try {
        let r: SearchHit;
        if (isAddress(query)) {
          const s = await api.status(query);
          r = { address: query as Hex, upId: s.upId, verified: s.isVerified };
        } else {
          const res = await api.resolve(query);
          const name = query.endsWith(".up.id") ? query.slice(0, -6) : query;
          r = { address: res.address, upId: res.address ? name : null, verified: res.verified };
        }
        searchCache.set(query.toLowerCase(), r);
        setHit(r);
      } catch {
        setHit({ address: null, upId: null, verified: false });
      }
    }, 300);
  }, [q]);

  const pick = () => {
    if (hit && hit !== "loading" && hit.address) {
      onSendTo(q.trim());
      setQ("");
      setOpen(false);
    }
  };

  return (
    <div className="gsearch" onBlur={() => window.setTimeout(() => setOpen(false), 150)}>
      <div className="gsearch-box">
        <Search size={15} strokeWidth={1.75} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => q.trim() && setOpen(true)}
          onKeyDown={(e) => e.key === "Enter" && pick()}
          placeholder="Find a name or address"
          aria-label="Find a name or address"
        />
      </div>
      {open && (
        <div className="gsearch-pop">
          {hit === "loading" && <div className="gsearch-empty"><Spinner /> resolving…</div>}
          {hit !== "loading" && hit && hit.address && (
            <button className="gsearch-hit" onMouseDown={pick}>
              {hit.verified ? <Seal small /> : <span className="gray-dot" aria-hidden="true" />}
              <span className="gsearch-hit-main">
                <span className="gsearch-hit-name">{hit.upId ? `${hit.upId}.up.id` : shortAddr(hit.address)}</span>
                <span className="gsearch-hit-sub mono">{hit.verified ? "Verified human · Send" : "Unverified · Send"}</span>
              </span>
              <SendHorizontal size={15} strokeWidth={1.5} />
            </button>
          )}
          {hit !== "loading" && hit && !hit.address && (
            <div className="gsearch-empty">No active name or account for that.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("send");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [prefillRecipient, setPrefillRecipient] = useState<string | null>(null);
  const [verifyId, setVerifyId] = useState<string | null>(null);
  const [onboarded, setOnboarded] = useState(() => hasAccount());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  // Lost-device recovery from a fresh session: render Arise standalone (it asks
  // for the account) WITHOUT the account-dependent shell, so no wallet is shown
  // until the user has actually recovered one.
  const [recovering, setRecovering] = useState(false);

  // Activity inbox badge: pending received return requests. `reqBump` re-fetches
  // on the same cadence as the status poll; the badge clears once Activity is
  // viewed (acked to the current count) and returns only when new ones arrive.
  const [reqBump, setReqBump] = useState(0);
  const reqMsg = useMessages(status?.address ?? null, reqBump);
  const pendingReq = reqMsg.activeRequests.length;
  const [ackedReq, setAckedReq] = useState(0);
  useEffect(() => {
    if (screen === "activity") setAckedReq(pendingReq);
  }, [screen, pendingReq]);
  const showReqBadge = pendingReq > ackedReq;

  const switchRefresh = useCallback(() => {
    lockMessages(); // drop the previous account's in-memory action session
    setStatus(null);
    setScreen("send");
    refresh();
  }, []);

  const refresh = useCallback(async () => {
    // No account on this device yet (fresh session): don't fetch anyone's
    // wallet — the app shows the empty onboarding state, not a populated one.
    const account = activeAccount();
    if (!account) {
      setStatus(null);
      return;
    }
    try {
      const s = await api.status(account);
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
    // Poll status, but skip while the tab is hidden — a backgrounded tab polling
    // the rate-limited RPC every few seconds is pure waste. Refresh immediately
    // when the tab becomes visible again so it never shows stale data on return.
    // (12s, up from 5s; post-write flows do their own immediate refetch.)
    const tick = () => {
      if (!document.hidden) {
        refresh();
        setReqBump((b) => b + 1); // re-fetch inbox for the Activity badge
      }
    };
    const t = window.setInterval(tick, 12000);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
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

  // Horizon 1 / S1.2: the dApp-SDK popup surface. Standalone (no wallet shell);
  // it runs the postMessage handshake and, if needed, onboarding right here.
  if (window.location.hash.replace(/^#/, "").startsWith("/connect")) {
    return <Connect />;
  }

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

  // Lost-device recovery from a fresh session: Arise standalone (no shell, so no
  // wallet is shown until an account is actually recovered). On success it sets
  // the recovered account active, then "Open wallet" enters the normal shell.
  if (recovering) {
    return (
      <div className="main">
        <div className="content">
          <Arise
            refresh={refresh}
            onDone={() => {
              setRecovering(false);
              setOnboarded(true);
              setScreen("send");
              refresh();
            }}
          />
        </div>
      </div>
    );
  }

  // Phase O §O5: fresh browsers meet onboarding first; the demo account is the
  // clearly-labeled legacy path. "Add account" from the switcher re-enters it.
  if (!onboarded || addingAccount) {
    return (
      <Onboard
        paused={status?.sponsoredOnboardingPaused ?? false}
        onRecover={() => setRecovering(true)}
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
  // The active account is on this device but has no passkey linked here. Don't
  // let any screen dead-end on "No passkey linked"; show a way out instead. The
  // Upgrade screen is exempt — that's where a demo account links in dev.
  const needsLink = !!status && !credentialFor(status.address) && screen !== "upgrade";
  const body = !status ? (
    error ? (
      <ErrNote error={error} />
    ) : (
      <div className="status-line">
        <Spinner /> connecting to guardian…
      </div>
    )
  ) : needsLink ? (
    <NeedsLink
      status={status}
      isDemo={isLegacyDemo()}
      onLinkDemo={() => setScreen("upgrade")}
      onManage={() => setSwitcherOpen(true)}
      onCreate={() => setAddingAccount(true)}
    />
  ) : (
    <>
      {SHOW_DEMO && screen === "upgrade" && <Upgrade status={status} onDone={() => setScreen("send")} />}
      {screen === "send" && (
        <Send status={status} refresh={refresh} prefillRecipient={prefillRecipient} />
      )}
      {screen === "activity" && <Activity status={status} />}
      {screen === "directory" && (
        <Directory
          onSendTo={(name) => {
            setPrefillRecipient(name);
            setScreen("send");
          }}
        />
      )}
      {screen === "card" && <Card status={status} />}
      {screen === "arise" && <Arise refresh={refresh} />}
      {screen === "limits" && <Limits status={status} refresh={refresh} />}
    </>
  );

  return (
    <div className="app">
      <header className="appbar">
        <a className="wordmark wordmark-home" href={LANDING_URL} title="Home — suho.wallet">
          Suho<span className="hanja">수호</span>
        </a>
        {status && <GlobalSearch onSendTo={(q) => { setPrefillRecipient(q); setScreen("send"); }} />}
        <div className="appbar-right">
          <a className="appbar-link" href={DOCS_URL} target="_blank" rel="noreferrer" title="Docs">
            <BookOpen size={16} strokeWidth={1.75} />
          </a>
          <a className="appbar-link" href={GITHUB_URL} target="_blank" rel="noreferrer" title="GitHub">
            <GithubMark size={15} />
          </a>
          <span className="status-pill" title="Network">
            <span className={`dot${error != null ? " err" : ""}`} /> GIWA Sepolia
          </span>
          {status && (
            <button className="acct-chip" onClick={() => setSwitcherOpen(true)} title="Switch account" aria-haspopup="menu">
              {status.isVerified ? <Seal small /> : <span className="gray-dot" aria-hidden="true" />}
              <span className="acct-chip-text">
                <span className="acct-name">{status.upId ? `${status.upId}.up.id` : "Suho account"}</span>
                <span className="acct-addr">{shortAddr(status.address)}</span>
              </span>
              <ChevronDown size={15} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </header>

      {status && (
        <nav className="navtabs" aria-label="Screens">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`navtab${screen === n.key ? " active" : ""}`}
              onClick={() => nav(n.key)}
            >
              <n.icon size={16} strokeWidth={1.5} />
              {n.label}
              {n.key === "activity" && showReqBadge && (
                <span className="nav-badge" aria-label={`${pendingReq} pending return request${pendingReq === 1 ? "" : "s"}`}>
                  {pendingReq}
                </span>
              )}
            </button>
          ))}
        </nav>
      )}

      <main className="main">
        <div className="content">
          {status && error != null && (
            <div className="status-banner" role="status">{humanError(error).text}</div>
          )}
          {body}
        </div>
      </main>

      {switcherOpen && (
        <AccountSwitcher
          onClose={() => setSwitcherOpen(false)}
          onSwitched={switchRefresh}
          onAddAccount={() => setAddingAccount(true)}
          onOpenAccount={() => {
            if (SHOW_DEMO) setScreen("upgrade"); // demo-only account/upgrade screen
          }}
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
    </div>
  );
}
