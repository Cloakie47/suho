# Deploying

Suho deploys in two halves. The static half (landing and docs) goes to a static host. The guardian goes to a Node host. The app is a static bundle that points at the deployed guardian.

Everything cross-origin is env-configurable, so nothing is hardcoded to one domain.

## What deploys where

| Piece | Host | State |
| --- | --- | --- |
| Landing + docs (`site/`) | Vercel (static) | Live now |
| App (`app/`) | Vercel (static) | Prepped; deploys after the contract phase |
| Guardian (`guardian/`) | Railway (Node) | Prepped; deploys after the contract phase |

The app and guardian wait for the contract phase because they wire to the accounts it ships. The landing and docs do not, so they go up first for a public URL.

## Landing + docs (static)

The landing is static in `site/`. The docs build into `site/docs`, so both serve from one folder and one deploy.

```bash
cd docs
npm install
SUHO_APP_URL=https://your-domain/ npm run docs:build   # outputs to ../site/docs
```

`SUHO_APP_URL` sets the docs "Launch app" link at build time. Until the app is deployed, point it at the landing root. The built `site/docs` is committed, so the host serves what is in the repo.

Vercel config lives in `vercel.json` at the repo root:

```json
{
  "framework": null,
  "buildCommand": null,
  "outputDirectory": "site",
  "cleanUrls": false
}
```

`cleanUrls: false` keeps the explicit `.html` links working on a plain static host. No build runs on the host; it serves `site/` as-is.

## App (static bundle)

The app reads two build-time variables:

| Variable | Purpose | Dev default |
| --- | --- | --- |
| `VITE_GUARDIAN_URL` | The deployed guardian origin | `http://localhost:8787` |
| `VITE_DOCS_URL` | The first docs content page | `http://localhost:8899/docs/overview/what-is-suho.html` |

```bash
cd app
npm install
VITE_GUARDIAN_URL=https://your-guardian VITE_DOCS_URL=https://your-domain/docs/overview/what-is-suho.html npm run build
```

The output in `app/dist` is a static bundle. It talks to the guardian over REST, so it needs the guardian to be up and to allow the app's origin (see CORS below).

## Guardian (Node)

The guardian reads these from the environment. Keys come from `.env` locally, from host variables in production. Never commit `.env`.

| Variable | Purpose |
| --- | --- |
| `PORT` | Listen port. Railway injects it; falls back to 8787 locally. |
| `SUHO_CORS_ORIGINS` | Comma-separated origin allowlist, e.g. `https://your-domain`. Unset means open (`*`), which is the dev default. |
| `SUHO_RELAYER_FLOOR_WEI` | Below this relayer balance, sponsored onboarding pauses (reimbursed ops continue). `0` or unset disables the floor. |
| `SUHO_ONBOARD_DAILY_CAP` | Max sponsored onboardings per UTC day (default 200). |
| `DEPLOYER_PRIVATE_KEY` | Relayer key (pays gas) and SuhoCodeAttester issuer. Testnet only. |
| `ALICE_PRIVATE_KEY` | Legacy demo EOA key, held only for the one-time 7702 upgrade. Testnet only. |

`GET /health` reports the live relayer balance, floor state, onboarding counts, relays served, and chain head with no secrets. See [Costs and limits](/developers/costs) for the reimbursement model and the sponsored-onboarding caps.

```bash
cd guardian
npm install
PORT=8787 SUHO_CORS_ORIGINS=https://your-domain npm run dev
```

Set `SUHO_CORS_ORIGINS` to the app's real origin in production. Only listed origins are echoed back; every other origin is refused at the browser. Leaving it open is a dev convenience, not a production setting.

On boot the guardian logs its port and the active CORS mode, so a misconfigured allowlist is visible in the first line of output.

## Never commit keys

`.env` stays out of the repo. In production, keys live as host variables (Railway) and nowhere else. The request-body guard already rejects anything key-shaped sent to any endpoint, but the deploy discipline is the same: keys are configuration, not code.
