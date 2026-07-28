# Suho — Demo Script v2 (post-Phase O)

Target runtime: **3:30 recorded** (act timings below). The story: a stranger
with nothing becomes a guarded, verified, named account — then every guardian
feature fires on that same account.

## Pre-flight (before recording)

**Windows open (only these visible):**
1. Browser in a **fresh profile** (no Suho state) at `http://localhost:5173`,
   ~1440px wide. What the viewer sees all demo: the hanji-light theme. Warm
   paper ground, white hairline cards, ink text, one red accent. Red appears
   only on seals, primary buttons, and active nav.
2. The recovery email inbox (for the Arise act) open in a tab. Recovery codes are
   emailed to the account's registered address; there is no public code page (the
   old `/issuer` portal is retired). The large-send act uses no code at all
   (hold-to-confirm + passkey).
Hidden but running: the guardian and vite terminals.

**Explorer tabs pre-opened (sepolia-explorer.giwa.io):**
- T1: blank tab ready for the new account's address page (you'll paste it —
  the `0xef0100…` code under the Contract tab is the money shot).
- T2: an earlier `execute()` send tx opened on its **Internal Transactions
  view** — this is where the actual ETH movement of a passkey send is visible
  (e.g. an earlier passkey `execute()` send).
- T3: the arise() tx `0x3677…6bc3`.

**Services health check (do this FIRST, catch a dead service before the take):**
Both services must be up. The app depends on the guardian for every read and
relay; a dead guardian shows as "Can't reach the guardian service" in the app.
- **App loads:** open `http://localhost:5173` — you land on onboarding (fresh
  profile) or the Send dashboard. If it shows the guardian-unreachable card,
  the guardian is down.
- **Guardian is serving:** open `http://localhost:8787/health` — it returns an
  ok JSON with the relayer balance and chain head.
- One-line check from a terminal (both should print `200`):
  `curl -s -o /dev/null -w "app %{http_code}\n" http://localhost:5173/ ; curl -s -o /dev/null -w "guardian %{http_code}\n" http://localhost:8787/health`
- If either is down: start it (guardian: `cd guardian && npm run dev`; app:
  `cd app && npm run dev`) and re-check before recording.

**Balances pre-flight:**
- Relayer (deployer key) ≥ 0.001 ETH — it pays gas for EVERYTHING in this demo.
- A funding stand-in wallet holding ≥ 0.02 ETH (see Act 1 fallback).
- Faucet pages logged in / captcha-warmed if you'll use them live.

**Budget for the demo account (it spends only transfer values; gas is always
the relayer's):** verify fee 0.001 + guarded send 0.0002 + warning send 0.0005
+ large hold-to-confirm send 0.011 + two arise proof sends 0.0002 = **0.0129 ETH. Fund 0.015**
(GIWA faucet 0.005 + Nodit 0.01, or the stand-in wallet) → ~0.002 headroom.

---

## Act 1 — A stranger, from nothing (0:00–0:50)

1. Fresh profile shows the paper-white welcome card: big red seal above
   **"Create your Suho account"** on a seal-red button. Click it → Windows
   Hello. Narrate: *"This is the key. There is no seed phrase — one was never
   made."*
2. Success card: address revealed, "Not yet verified", balance 0. Paste the
   address into explorer tab T1 → show the `0xef0100…` code. *"Born a smart
   account. The bootstrap key signed twice in that tab and is already gone."*
3. Home shows the **guided checklist** as a white card, steps numbered in
   hairline circles. Step 1 Fund: QR + copy — send 0.015 from faucet or
   stand-in. Balance flips live (Flashblocks) in the white sidebar identity
   card, numerals in General Sans.
4. Step 2 **Verify me** → Hello → a white toast slides in top-right, red rule
   on its left edge, and the red seal stamps in. *"The account just attested
   itself with the testnet issuer — 0.001 fee, passkey-signed."*
5. Step 3 **Claim your name** → type the name → Hello → the sidebar identity
   flips to `<name>.up.id` beside its red seal. *(Have 2–3 name candidates
   ready — see fallbacks.)*

**Fallbacks:** faucet slow/captcha → use the stand-in wallet and say "any
faucet or exchange"; name taken → next candidate; onboarding returns but Home
looks empty → wait 2–3 s (stale RPC nodes; the app re-polls).

## Act 2 — Send to a verified human (0:50–1:15)

Recipient `suho` → live-resolves in the composer card: big red seal, jade
**"Verified human"** label. Send **0.0002** → Hello → the toast mutates:
spinner and shimmering tile curve → **"Sent · 0.9s"** in jade with the seal
stamping (real measured number, say it out loud) → Confirmed. Checklist
completes and collapses to the recovery-honesty line — read it: *"Your passkey
is the only key."*

**Fallback:** timing shows >2s on a slow RPC day — the number is real either
way; don't apologize, point at it.

## Act 3 — The stranger warning (1:15–1:40)

Paste mallory `0xB53Af3C7a3338f7CfE8df3E3D63104C53B93B0B2`, amount **0.0005**
→ the recipient card shows a warning triangle on warm amber tinting, no seal:
*"Unverified address. Suho can't identify who this is."* Send anyway — small
amounts warn, not block.

## Act 4 — The Guard: a large send to a stranger (1:40–2:20)

Same recipient, amount **0.011** → Send → a **white modal over the dimmed paper
ground**: a warning tile and a **hold-to-confirm** button that fills as you press
and hold. Hold it, then complete the passkey prompt → success toast. *"A large
send to an address Suho can't identify stops for a deliberate confirmation. Be
honest about what protects you: it's your passkey — bound to THIS recipient and
THIS amount — plus friction that stops a stray tap. There's no one-time code. We
removed the code that used to sit here because the guardian minted it from the
same passkey that signed the send, so it protected nothing while pretending to.
A real, email-delivered second factor is planned as hardening, not shipped as
theater."*

**Fallbacks:** passkey canceled → the modal returns; guard emits an
`UnverifiedLargeSend` event you can point at on the explorer.

## Act 5 — Arise (2:20–3:00)

*"The phone is gone. Watch what does NOT happen: no seed phrase, no support
ticket, no new address."* Arise screen: numbered step rail on the left (active
step ringed in red), white cards on the right. Enter the account to recover →
create new passkey (Hello, "the new phone") → request code → read the recovery
code from the **email inbox** → **Arise** → toast: "You have risen · X.Xs".
Prove-it: two side-by-side white cards, red ✗ old passkey (toast: *"This
passkey can't sign for the account"*), jade ✓ new passkey (0.0001 send lands).
Point at tab T3.

**Fallback:** if the old-key test is skipped for time, the ✗ card copy still
tells the story — don't force it.

## Act 6 — Directory + Card + close (3:00–3:30)

1. Directory: 50k+ verified names as white table rows, a red seal on every
   one. Search your new name — *"only verified humans can appear here, by
   construction."* Deep-link Send off `suho`'s row (the Send button appears on
   hover).
2. Card: show the new account's card if you created one, or click the sidebar
   identity card → the **account switcher** ("Accounts on this device") →
   pick alice's row to show her v2 card. The card renders as warm-sheened
   paper with seal, fields, gold version chip, and the honesty small print —
   read it. The Versions rail shows v1 revoked, v2 current, and the title
   line states whose card it is.
3. Close on explorer tab T2 — the internal-transactions view of a send:
   *"Every claim you just saw is a transaction. The proof section of our site
   links all of them."*

---

## Recording notes

- One 3:30 take beats a stitched 5:00. If a live faucet stalls, cut and resume
  at the funded state; everything else should run unbroken.
- Total RPC outage: fall back to the pre-opened explorer tabs + the 45 green
  fork tests; the receipts carry the story.
- Keep the pointer still during toasts — the seal stamp is the shot.
