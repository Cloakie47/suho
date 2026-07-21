# Suho — Phase R: App Redesign (reference-level craft, same identity)

Governing skill: .claude/skills/suho-design/SKILL.md (tokens, motion, seal rules all still apply).
Problem being fixed: the app currently renders as a narrow 480px column floating in empty ink on desktop — layout poverty, flat elevation, default-looking type. Reference bar: dense premium dashboards (layered cards, sidebar + content, stat rows, activity feeds) executed in SUHO's dark Korean identity, not the references' pastel palette.

## R1. App shell — two-pane desktop layout (the big fix)

Kill the floating column. New shell at ≥1024px:
- LEFT SIDEBAR (300px, ink-raised, full-height, 1px border paper@6%):
  - Wordmark Suho 수호
  - Identity card: seal stamp, up.id name, truncated address (copy on click), balance in display face, attestation line, readiness chip
  - Nav: Send / Directory / Card / Arise — real nav items (icon + label, active = seal left-rule + ink-lift), not text links in a header
  - Bottom: network pill ("GIWA Sepolia · ~0.9s preconf"), guardian status dot
- MAIN AREA (fluid, max 960px content, 32px gutters): the active screen, now allowed to breathe wide.
- <1024px: sidebar collapses to top bar + bottom tab nav (Send/Directory/Card/Arise). The 480px column concept survives ONLY as mobile.

## R2. Home/Send becomes a dashboard, not a lone form
Grid (2-col at desktop):
- Row 1, full width: send composer as the hero card (recipient + amount + button on one line at desktop), recipient resolution card animating in below it.
- Row 2: three stat cards (reference-style, OUR data): "Sends this session" / "Avg preconfirmation" (real measured rolling avg) / "Verified recipients" (count from directory). Numerals in display face, labels paper-dim, one jade or seal accent numeral max.
- Row 3: ACTIVITY feed — reverse-chron list of this wallet's real transactions (from chain via guardian, cached): icon (seal=verified send, amber=unverified, rotate=arise, card=card), counterparty name or address, amount, measured ms if known, explorer link on hover. Skeleton rows while loading, empty state with an invitation ("No sends yet — try suho.up.id").

## R3. Elevation & surface system (depth like the references, in ink)
Three levels, used consistently: L0 page ink; L1 cards (ink-raised, 1px paper@6% border); L2 floating elements (toasts, dropdowns, interstitial: ink-raised +2%, blur 20px, shadow 0 12px 40px rgba(0,0,0,.5), 1px paper@10%). Every interactive card: hover = translateY(-1px) + border paper@12%, 200ms. The hero send card gets the faint seal radial glow (the only glow in the app).

## R4. Type & icon discipline
- VERIFY the fonts actually load (current screenshots look like system fallback): Clash Display for balance/stat numerals + screen titles; Pretendard body; Plex Mono for addresses/hashes/ms. font-display swap + size-adjust.
- Icons: lucide-react throughout nav/activity/stats — consistent 18px, 1.5px stroke, paper-dim default. No emoji, no mixed icon sets.
- Screen titles get an eyebrow (mono, paper-dim, e.g. "GUARDED TRANSFER") + display-face title. Consistent 28px/8px rhythm.

## R5. Screen-by-screen composition pass
- Upgrade/success (currently a checkmark in a void): two-col success composition — left: the message + code + Continue; right: a rendered mini Suho Card preview or seal motif. No screen may be a single small element centered in emptiness.
- Directory: table-like rows (seal, name, address mono, Send action on hover), sticky search, count header ("55,048 verified names").
- Card screen: the card itself rendered at credit-card proportion with the L2 treatment + gentle 3D tilt on hover (shared component with the future landing hero); history as a timeline rail (seal dot = current, hollow = revoked with timestamp).
- Arise: keep the theater, add composition — steps as a numbered rail (this IS a real sequence, numbering earns its place), the prove-it panel as two L1 cards side by side (old key ✗ / new key ✓).
- OTP interstitial: L2 modal over dimmed ink, code boxes (6 individual inputs), countdown ring around the timer.

## R6. Do-not-touch list
No palette changes, no light theme, no new features, no changes to guardian endpoints or contract calls, no touching the tx/signing logic. This is presentation only. Re-verify all flows after (typecheck + live render pass; passkey flows re-confirmed by the user's next real send).

## Acceptance
- 1440px screenshot of every screen: no screen >30% empty ink; sidebar shell present; fonts verifiably loaded (display face visible in numerals).
- Mobile (390px) still clean with tab nav.
- All flows regression-verified. Screenshots re-captured for the landing page's §3 crops AFTER this pass (the old crops are now stale by definition).
