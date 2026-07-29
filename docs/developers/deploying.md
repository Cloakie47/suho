# Deploying

Suho deploys in three parts. The static landing and docs and the app static bundle go to Cloudflare Pages. The guardian goes to a Node host on Railway. The app is a static bundle that points at the deployed guardian over REST.

Everything cross-origin is env-configurable, so nothing is hardcoded to one domain.

## What deploys where

| Piece | Host | Live at |
| --- | --- | --- |
| Landing + docs (`site/`) | Cloudflare Pages (static) | `https://suhowallet.com` |
| App (`app/`) | Cloudflare Pages (static) | `https://app.suhowallet.com` |
| Guardian (`guardian/`) | Railway (Node) | `https://api.suhowallet.com` |

Order matters: deploy the guardian first and confirm `https://api.suhowallet.com/health` responds, then build the app (its guardian URL is baked in at build time), then the landing and docs.

## Landing + docs (Cloudflare Pages, static)

The landing is static in `site/`. The docs build into `site/docs`, so both serve from one folder and one deploy.

- **Build command:** `cd docs && npm ci && npm run docs:build && cd ../site && node inject-config.mjs`
- **Build output directory:** `site`
- **Env:** `SUHO_APP_URL=https://app.suhowallet.com` (read by both the docs "Launch app" link and the landing's Launch-app CTA), `NODE_VERSION=20`.

`docs:build` compiles VitePress into `../site/docs` (base `/docs/`), then `inject-config.mjs` rewrites the landing's Launch-app URL from the localhost dev default to `SUHO_APP_URL`. `cleanUrls: false` keeps the explicit `.html` links working on a plain static host, so `/` serves the landing and `/docs/*.html` serves the docs with no rewrite rules.

## App (Cloudflare Pages, static bundle)

The app reads these build-time variables. Point them at production:

| Variable | Value | Dev default |
| --- | --- | --- |
| `VITE_GUARDIAN_URL` | `https://api.suhowallet.com` | `http://localhost:8787` |
| `VITE_RP_ID` | `suhowallet.com` | `localhost` |
| `VITE_APP_URL` | `https://app.suhowallet.com` | current origin |
| `VITE_LANDING_URL` | `https://suhowallet.com/` | `http://localhost:8899/` |
| `VITE_DOCS_URL` | `https://suhowallet.com/docs/overview/what-is-suho.html` | localhost docs |

- **Build command:** `cd app && npm ci && npm run build`
- **Build output directory:** `app/dist`
- `VITE_RP_ID` is the WebAuthn Relying Party ID passkeys bind to. It must be the app's registrable domain, so a passkey created on `app.suhowallet.com` sets `suhowallet.com`. A mismatch makes every passkey create and sign fail. `VITE_APP_URL` is used to build the card QR link to the shareable `/verify` view.

The output in `app/dist` is a static bundle. It talks to the guardian over REST, so the guardian must be up and must allow the app's origin (see CORS below). `VITE_*` values are baked at build time, so changing one needs a rebuild, not just an env change.

## Guardian (Railway, Node)

Railway root directory is `guardian`; build is `npm install`; start is `npm start` (it runs TypeScript directly through `tsx`, no compile step). Attach the Postgres service so `DATABASE_URL` is injected, and leave `DATABASE_PUBLIC_URL` unset so the internal host is used.

The guardian reads these from the environment. Keys come from `.env` locally, from host variables in production. Never commit `.env`.

| Variable | Purpose |
| --- | --- |
| `PORT` | Listen port. Railway injects it; falls back to 8787 locally. |
| `SUHO_CORS_ORIGINS` | Origin allowlist, set to `https://app.suhowallet.com`. Unset means open (`*`), the dev default. |
| `DATABASE_URL` | Postgres connection. Injected by attaching the Railway Postgres service (internal host). |
| `DEPLOYER_PRIVATE_KEY` | Relayer key (pays gas) and SuhoCodeAttester issuer (mints recovery codes). Testnet only. |
| `ALICE_PRIVATE_KEY` | Legacy demo EOA key, held only for the one-time 7702 upgrade. Testnet only. |
| `RESEND_API_KEY` | Sends recovery and confirmation email through Resend. |
| `SUHO_EMAIL_ENC_KEY` | Encrypts recovery emails at rest. Must stay constant, or stored emails become undecryptable. |
| `SUHO_EMAIL_FROM` | Sender, e.g. `Suho <no-reply@suhowallet.com>` (a Resend-verified domain). |
| `SUHO_OPS_TOKEN` | Bearer token for the `/ops` monitoring endpoint. |
| `SUHO_RELAYER_FLOOR_WEI` | Below this relayer balance, sponsored onboarding pauses; reimbursed ops continue. `0` or unset disables it. |
| `SUHO_ONBOARD_DAILY_CAP` | Max sponsored onboardings per UTC day (default 200). |

`GET /health` reports the live relayer balance, floor state, onboarding counts, relays served, and chain head with no secrets. See [Costs and limits](/developers/costs) for the reimbursement model and the sponsored-onboarding caps.

Set `SUHO_CORS_ORIGINS` to the app's real origin in production. Only listed origins are echoed back; every other origin is refused at the browser. Leaving it open is a dev convenience, not a production setting. On boot the guardian logs its port, the active CORS mode, and whether the database schema is ready, so a misconfiguration is visible in the first lines of output.

## Never commit keys

`.env` stays out of the repo. In production, keys live as host variables (Railway) and nowhere else. The request-body guard already rejects anything key-shaped sent to any endpoint, but the deploy discipline is the same: keys are configuration, not code.
