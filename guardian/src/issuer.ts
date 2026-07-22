/// Phase T item 4 — the Verification Service portal (simulated testnet issuer).
///
/// Replaces the terminal-as-delivery. Codes are recorded here and shown on a
/// styled page at GET /issuer that polls GET /issuer/codes. The console banner
/// and codes.log stay as fallbacks. On mainnet this channel is the issuer's own
/// app; here it simulates that for the testnet attester.

export type CodeKind = "transfer" | "recovery";

export interface IssuedCode {
  id: string;
  account: `0x${string}`;
  kind: CodeKind;
  code: string;
  issuedAt: number; // unix seconds
  expiresAt: number; // unix seconds
  recipient?: string; // transfer
  valueWei?: string; // transfer
}

const codes: IssuedCode[] = [];
let seq = 0;

export function recordCode(c: Omit<IssuedCode, "id" | "issuedAt">): IssuedCode {
  const rec: IssuedCode = { ...c, id: `c${++seq}`, issuedAt: Math.floor(Date.now() / 1000) };
  codes.push(rec);
  return rec;
}

/** Non-expired codes, newest first. */
export function activeCodes(): IssuedCode[] {
  const now = Math.floor(Date.now() / 1000);
  return codes.filter((c) => c.expiresAt > now).sort((a, b) => b.issuedAt - a.issuedAt);
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The portal HTML. Self-contained, design-skill styled, polls /issuer/codes. */
export function issuerPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Verification Service · Suho</title>
<link rel="preconnect" href="https://api.fontshare.com" crossorigin />
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=general-sans@500,600&display=swap" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap" />
<style>
  :root {
    --hanji:#faf7f0; --hanji-raised:#fff; --ink:#1c1917; --ink-dim:#6e6862;
    --line:#e8e2d8; --seal:#d93a25; --seal-deep:#a82415; --gild:#b08a47; --jade:#3e7a5e;
    --display:"General Sans","Segoe UI",system-ui,sans-serif;
    --body:"Pretendard Variable",Pretendard,"Malgun Gothic",sans-serif;
    --mono:"IBM Plex Mono",Consolas,monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--hanji); color:var(--ink); font-family:var(--body); }
  .wrap { max-width:720px; margin:0 auto; padding:40px 20px 64px; }
  header { display:flex; align-items:center; gap:14px; margin-bottom:6px; }
  .seal { display:inline-flex; align-items:center; justify-content:center; width:44px; height:44px;
    border:3px solid var(--seal); border-radius:9px; color:var(--seal); font-weight:700;
    transform:rotate(-4deg); box-shadow:inset 0 0 8px rgba(120,30,20,.3); font-family:var(--body); }
  h1 { font-family:var(--display); font-weight:600; font-size:1.5rem; margin:0; letter-spacing:-0.01em; }
  .sub { color:var(--ink-dim); font-size:0.9rem; margin:0; }
  .honest { background:#fbf3e4; border:1px solid rgba(138,90,27,.3); color:#8a5a1b;
    border-radius:12px; padding:12px 14px; font-size:0.85rem; margin:18px 0 24px; }
  .empty { color:var(--ink-dim); text-align:center; padding:48px 0; font-size:0.95rem; }
  .code-card { background:var(--hanji-raised); border:1px solid var(--line); border-left:3px solid var(--seal);
    border-radius:14px; padding:18px 20px; margin-bottom:14px; box-shadow:0 1px 2px rgba(28,25,23,.05); }
  .code-top { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
  .kind { font-family:var(--mono); font-size:0.7rem; letter-spacing:0.1em; text-transform:uppercase; color:var(--ink-dim); }
  .digits-row { display:flex; align-items:center; gap:12px; margin:8px 0 6px; }
  .digits { font-family:var(--mono); font-size:2.1rem; font-weight:500; letter-spacing:0.18em;
    background:none; border:0; padding:2px 6px; margin:0 -6px; color:var(--ink); cursor:pointer;
    border-radius:8px; }
  .digits:hover { background:rgba(217,58,37,.06); }
  .digits:focus-visible { outline:2px solid var(--seal); outline-offset:2px; }
  .copy-btn { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--line-strong,#dcd4c7);
    background:none; color:var(--ink-dim); border-radius:999px; padding:5px 11px; font-family:var(--body);
    font-size:0.78rem; cursor:pointer; }
  .copy-btn:hover { color:var(--ink); border-color:var(--ink-dim); }
  .copy-btn:focus-visible { outline:2px solid var(--seal); outline-offset:2px; }
  .copy-btn.done { color:var(--jade); border-color:rgba(62,122,94,.4); }
  .copy-btn svg { width:14px; height:14px; }
  .meta { font-family:var(--mono); font-size:0.76rem; color:var(--ink-dim); line-height:1.6; }
  .countdown { font-family:var(--display); font-weight:600; color:var(--jade); }
  .countdown.soon { color:var(--seal); }
  .foot { text-align:center; color:var(--ink-dim); font-size:0.75rem; margin-top:30px; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--jade);
    margin-right:6px; animation:pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity:.35; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="seal">수호</span>
    <div>
      <h1>Verification Service</h1>
      <p class="sub">testnet issuer, simulated</p>
    </div>
  </header>
  <div class="honest">
    On mainnet, codes are delivered by the issuer's own app. This page simulates that channel for the testnet issuer.
  </div>
  <div id="list"><div class="empty">No active codes. Request one from the app.</div></div>
  <p class="foot"><span class="dot"></span>live · codes appear here the moment they are issued</p>
</div>
<script>
  const label = { transfer: "Transfer verification", recovery: "Account recovery" };
  function fmt(s){ const m=Math.floor(s/60), ss=String(s%60).padStart(2,"0"); return m+":"+ss; }
  async function tick(){
    let data;
    try { data = await (await fetch("/issuer/codes")).json(); } catch { return; }
    const now = Math.floor(Date.now()/1000);
    const active = (data.codes||[]).filter(c => c.expiresAt > now);
    const el = document.getElementById("list");
    if (!active.length){ el.innerHTML = '<div class="empty">No active codes. Request one from the app.</div>'; return; }
    const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    el.innerHTML = active.map(c => {
      const left = c.expiresAt - now;
      const soon = left < 60 ? " soon" : "";
      const extra = c.kind === "transfer"
        ? \`to \${c.recipient ? c.recipient.slice(0,10)+"…" : "?"} · \${(Number(c.valueWei||0)/1e18).toFixed(4)} ETH\`
        : "new passkey rotation";
      return \`<div class="code-card">
        <div class="code-top"><span class="kind">\${label[c.kind]||c.kind}</span>
        <span class="countdown\${soon}">\${fmt(left)}</span></div>
        <div class="digits-row">
          <button class="digits" data-code="\${c.code}" title="Click to copy" aria-label="Copy code \${c.code}">\${c.code.slice(0,3)} \${c.code.slice(3)}</button>
          <button class="copy-btn" data-code="\${c.code}" aria-label="Copy code">\${copyIcon}<span>Copy</span></button>
        </div>
        <div class="meta">account \${c.account.slice(0,10)}…\${c.account.slice(-4)}<br/>\${extra}</div>
      </div>\`;
    }).join("");
  }
  async function copy(code, btn){
    try { await navigator.clipboard.writeText(code); }
    catch { const t=document.createElement("textarea"); t.value=code; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
    // confirm on the pill (or a floating pill if the digits were clicked)
    const pill = btn.classList.contains("copy-btn") ? btn : btn.parentElement.querySelector(".copy-btn");
    if (!pill) return;
    const span = pill.querySelector("span"); const prev = span ? span.textContent : "";
    pill.classList.add("done"); if (span) span.textContent = "Copied";
    setTimeout(() => { pill.classList.remove("done"); if (span) span.textContent = prev || "Copy"; }, 1400);
  }
  document.getElementById("list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-code]");
    if (b) copy(b.dataset.code, b);
  });
  tick(); setInterval(tick, 1000);
</script>
</body>
</html>`;
}
