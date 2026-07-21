---
name: suho-design
description: Suho's design language and quality bar. Use for ANY user-facing UI work in this repo — the landing page, app screens, toasts, empty states, or visual polish. Defines palette, type, motion, the signature 3D card, toast system, and AI-image asset rules.
---

# Suho Design Language

Suho is a guardian wallet on GIWA: Korean-modern fintech, not crypto-cyberpunk, not pastel-SaaS. The reference mood is premium studio work (layered glass, depth, one orchestrated 3D moment, restrained micro-motion) executed in SUHO'S OWN palette and vocabulary — never in mint/lavender medical gradients. The app screens already establish the identity; the landing page elevates it, it does not replace it.

## Tokens

Color (dark, warm, lacquered):
- `--ink`        #121110  — page ground (warmer than pure black; think charcoal lacquer)
- `--ink-raised` #1C1A18  — cards, nav, raised surfaces
- `--paper`      #F3EFE7  — primary text; hanji-paper off-white
- `--paper-dim`  #A8A29A  — secondary text
- `--seal`       #E8442E  — THE accent: dojang seal red-orange. Actions, seal marks, key numerals
- `--seal-deep`  #8C2318  — pressed states, seal shadow, gradient partner
- `--gild`       #C9A15C  — sparse gold: version numbers, "first on GIWA" credentials, thin rules. ≤5% of any view
- `--jade`       #4C8A6E  — success/verified-adjacent states only (toasts, checkmarks). Never decorative

Gradients: permitted only as (a) seal→seal-deep on primary CTAs, (b) a faint radial warm glow behind the hero card (ink-raised→ink). No full-bleed pastel washes.

Type:
- Display: a rounded-geometric face with real presence (e.g. "Clash Display" or "Cabinet Grotesk" via fontshare CDN) — headlines, numerals. Tight tracking, weights 500–600, never thin.
- Body: "Pretendard" (CDN: jsdelivr pretendard) — a Korean-designed grotesk that renders 수호 and Latin beautifully from one family. This choice IS part of the brand; do not substitute Inter.
- Mono: "IBM Plex Mono" — addresses, hashes, code, timing numerals (e.g. "0.9s").
- The hangul 수호 appears beside the Latin wordmark at all sizes. Small hangul captions (e.g. 지붕 아래 — "under the roof") may appear as eyebrow labels; always subtle, never decoration-only — each must caption something real.

Geometry & texture:
- Radius: 14px cards, 10px controls, 999px pills. The Suho Card itself: 18px (credit-card proportions, 1.586:1).
- The tile curve (single S-curve line, already used as the app divider) is the recurring structural motif: section dividers, underline accents, the loading shimmer path.
- Seal marks: the verified badge is always the red square-seal stamp with 수호, slightly rotated (−4°), with a subtle press-in shadow — like ink on paper, never a flat icon.
- Depth: glass layers are allowed (blur 16–24px, 1px inner border at 8% paper) but only floating OVER the ink ground — no white glassmorphism.

Motion (orchestrated, sparse, purposeful):
- One page-load sequence on the landing hero (see below), scroll-reveals at 12–16px rise + fade (80ms stagger), and hover micro-tilt on the Card. Nothing else animates ambiently.
- Durations 180–320ms, ease `cubic-bezier(.2,.7,.2,1)`. Respect `prefers-reduced-motion`: all transforms collapse to opacity fades.
- The seal-stamp animation (scale 1.15→1 with a 1-frame rotation settle, like a stamp pressing) is reserved for moments of VERIFICATION: verified-recipient resolution, successful sends, card creation. It is the brand's signature micro-interaction — never use it for neutral events.

## Landing page (site/ — static, single page, no framework needed; Vite vanilla or plain HTML+CSS+JS)

Job: convince a GASOK judge in 60 seconds that Suho is real, live, and inevitable. Every claim links to chain evidence.

Structure (in order):
1. HERO — the thesis. Left: wordmark (Suho 수호), headline "A wallet that guards you." subline "Send to names, not addresses. Recover without a seed phrase. Live on GIWA." Two CTAs: "Launch app" (seal gradient) + "Read the proof" (ghost, anchors to §5). Right: THE SIGNATURE — the Suho Card rendered as a 3D floating object (CSS 3D transform, perspective 1200px), tilting toward the cursor (max ±9°), with the seal, alice.up.id, QR, and "v2" chip visible; a soft seal-glow underneath. Load sequence: ink fades in → card rises + settles → seal stamps onto the card → headline types nothing, just fades (no typewriter effects).
2. THE PROBLEM — three short lines, no cards, big type: seed phrases lose money / addresses hide scammers / bots farm everything. Each with a thin gild rule.
3. HOW SUHO GUARDS — four features as glass cards over ink: Verified humans (seal + up.id), The Guard (OTP interception), Arise (resurrection), The Card (attested identity). Each card: one screenshot-crop of the REAL app screen (assets/shots/, see asset rules), one sentence, one mono-type chain fact (e.g. the arise tx hash, short).
4. LIVE ON GIWA — the credibility strip: "First EIP-7702 passkey account on GIWA" (gild), preconf timing "~0.9s", "4 contracts source-verified", "55,048 verified names indexed". Mono type, each linking to explorer/GitHub evidence.
5. THE PROOF — compact table of the live tx milestones (upgrade, send, OTP, arise) with explorer links, styled like a ledger. This section is why judges trust the rest.
6. FOOTER — GitHub, demo video (when it exists), "Built for GASOK · GIWA Sepolia", the honesty line about testnet issuer, tile-curve sign-off.

Copy rules: plain verbs, sentence case, zero hype-words ("revolutionary", "seamless", "next-gen" are banned). Specifics beat adjectives: "recovers in one code" not "effortless recovery". The register is calm confidence — a guardian doesn't shout.

## Toast system (app/ — this is an APP change, applies to every transaction flow)

One toast component, top-right stack (mobile: top-center), max 3 visible, ink-raised glass, 14px radius, seal-red left rule 3px.

Lifecycle per transaction (single toast that MUTATES, never a new toast per phase):
1. pending — spinner + "Sending 0.0002 to suho.up.id…" (verb matches the button that launched it)
2. preconfirmed — tile-curve shimmer completes + "Sent — 0.9s" with the REAL measured ms, jade check, seal-stamp micro-animation
3. final (block inclusion) — quiet swap to "Confirmed", explorer link icon. Auto-dismiss 6s after final; pending/error never auto-dismiss.
Errors: typed revert names mapped to human sentences in the interface's voice — OtpRequired → (no toast; the interstitial IS the response), CodeInvalid → "That code didn't match. Check the verification window.", CodeExpired → "Code expired. Request a fresh one.", InvalidPasskeySignature → "This passkey can't sign for the account." Errors state what happened + the next action; they never apologize and never show raw hex (keep a "details" disclosure for the raw error).
Same component serves Arise ("You have risen — 1.4s") and Card ("Card v2 created"). Action name continuity: the button said "Sign & update", the toast says "Updated".

## AI-generated image assets (optional enrichment, never a dependency)

The page must be COMPLETE with zero AI images (CSS/SVG carries the design). If the user supplies renders, they slot in as: (a) hero backdrop texture — a dark macro shot of glazed roof tiles, heavily darkened to ≤15% visibility; (b) an "under the roof" section divider image. Specs for the user to generate externally: 2400×1350 WebP, dark charcoal palette with warm highlights only, no text in image, no people, no logos. Prompts to try: "macro photograph of dark glazed Korean giwa roof tiles at dusk, warm rim light, deep charcoal, minimal, premium product photography" / "single traditional Korean roof tile floating on black background, studio lighting, red lacquer reflection". Reject any output with mint/blue gradients. App screenshots in §3 are NOT AI images — capture them from the real running app.

## Quality floor (non-negotiable)
Responsive to 380px; keyboard focus visible (seal outline 2px); reduced-motion respected; Lighthouse a11y ≥ 95; no layout shift on font load (font-display swap + size-adjust); the site works file:// or any static host. Before calling any UI work done: screenshot it, look at it, remove one accessory (Chanel rule), then ship.
