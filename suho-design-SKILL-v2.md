---
name: suho-design
description: Suho's design language and quality bar, v2 (hanji light theme). Use for ANY user-facing UI work — app screens, landing page, toasts, copy. Defines palette, type, motion, copy voice, the account switcher, and asset rules. Supersedes v1 (dark ink theme) entirely.
---

# Suho Design Language v2 — Hanji Light

Suho is a guardian wallet on GIWA. The look: warm Korean paper, ink text, one red seal accent. Premium and airy like top studio work, executed in Suho's own vocabulary. Never pastel-medical (no mint, lavender, baby blue), never crypto-dark, and NEVER purple. If a purple/indigo element exists anywhere in the app, replacing it with --seal is part of your task.

## Tokens

- `--hanji`       #FAF7F0  page ground (warm paper, not white)
- `--hanji-raised`#FFFFFF  cards and raised surfaces
- `--ink`         #1C1917  primary text
- `--ink-dim`     #6E6862  secondary text
- `--line`        #E8E2D8  hairline borders
- `--seal`        #D93A25  THE accent. Primary buttons, active nav, seal stamps, links. The only saturated color.
- `--seal-deep`   #A82415  pressed states, gradient partner (seal→seal-deep on primary CTAs only)
- `--gild`        #B08A47  sparse: version chips, credential lines, thin rules. ≤5% of any view
- `--jade`        #3E7A5E  success states only (toasts, done checks). Never decorative
- `--warn-bg` #FBF3E4 / `--warn-ink` #8A5A1B  warning chips and cards — a chip tints ITSELF, never its parent (the gold-sidebar bug class)

Shadows carry depth now (light theme): cards `0 1px 2px rgba(28,25,23,.05)`, raised/hover `0 8px 24px rgba(28,25,23,.08)`, modals `0 16px 48px rgba(28,25,23,.14)`. No glassmorphism on light; use solid hanji-raised + hairline.

## Type

- Display: **General Sans** (Fontshare CDN), 500/600, tight tracking — screen titles, balances, stat numerals, landing headlines.
- Body/UI: **Pretendard** (jsdelivr CDN) — everything else, Latin + 수호 from one family. Not Inter, not system.
- Mono: **IBM Plex Mono** — addresses, hashes, timings, eyebrows.
- MANDATORY CHECK: verify in devtools that all three faces actually render (document.fonts + visual check); font-display swap + size-adjust fallbacks. If any screen shows system fallback, that is a bug to fix in this task.
- Hangul: 수호 beside the wordmark everywhere; at most one hangul eyebrow per screen, always captioning something real.

## Identity elements

- Seal stamp: red square-seal with 수호, rotated −4°, press-in shadow. Marks VERIFIED things only.
- Tile curve: the single S-curve as section divider and loading shimmer. Unchanged from v1.
- Suho Card: 18px radius, 1.586:1, hanji-raised with a faint warm sheen (subtle diagonal gradient white→hanji), seal + name + QR. Same component on app Card screen and landing hero (3D cursor tilt ±9° on landing only).

## Copy voice (this is now part of design — apply to ALL UI text and landing copy)

- NO em dashes. Use a period and a new sentence, or a comma. Audit every string; this includes existing copy.
- Short sentences. One idea per sentence. Sentence case.
- Plain words over jargon at the surface: say "Your passkey signs every transaction." not "Day-to-day authority is a WebAuthn P-256 key". Technical receipts (P256VERIFY, type-4, 0xef0100) live only in mono chain-fact lines and tooltips, never in explanatory sentences.
- Banned: seamless, revolutionary, next-gen, cutting-edge, empower, unlock. Also banned: three-part constructions ending in a punchline.
- Every explainer card: max 2 sentences. If it needs three, it needs a doc link instead.
- Rewrite pass examples:
  - "Arise — one code, no seed phrase" → "Arise: one code. No seed phrase."
  - "This address is now a smart account, secured by your passkey. The old key can go in a drawer." → "This address is now a smart account. Your passkey controls it." (drawer line moves to a tooltip)
  - "EIP-7702 upgrades the account in place — Dojang attestation and up.id survive." → "The upgrade keeps your address. Your name and verification stay."

## Account switcher (new, required)

There is no logout because there are no sessions; there are accounts on this device. The sidebar identity card becomes a button:
- Click → popover listing every account this browser knows (localStorage registry: address, name if any, seal if verified, "demo" tag for alice's legacy path), current one checked.
- Actions at the bottom: "Add account" (runs onboarding) and "Use demo account" (legacy alice path) if not already listed.
- Switching swaps activeAccount() and refreshes; no confirmation needed (nothing is signed by switching).
- Each row shows enough to never confuse accounts: seal (or gray unverified dot), name or truncated address. The Card screen additionally states whose card it is under the title ("alice.up.id's card").
- Remove-from-this-device (small, per row, confirm dialog): forgets the local entry only; copy states the account itself lives on chain and the passkey still exists in the device's credential manager.

## States (the gold-sidebar bug class, fixed by rule)

A status chip colors itself, never its container. Sidebar identity card is ALWAYS hanji-raised with hairline; "Demo headroom low" renders as a small warn-bg/warn-ink chip inside it. Verify every warning/error/success state in the app obeys this after the retheme.

## Landing page

Same structure as previously approved (hero + problem + five moments + credibility strip + proof ledger + footer), restyled to this system: hanji ground, ink type, seal CTAs, the 3D tilting Suho Card as hero. Synova-class airiness is the reference for spacing and calm, NOT for its palette. Copy voice rules apply to every line, including existing ones (the em-dash audit covers the landing).

## Quality floor (unchanged, plus)

380px responsive; visible focus (2px seal); reduced-motion → fades; Lighthouse a11y ≥ 95; no CLS on font load; screenshot review before done (check specifically: no purple anywhere, no container-tinting states, fonts actually loaded, no em dash in any rendered string).
