# Running locally

Suho is three packages in one repo: `contracts` (Foundry), `guardian` (Node), and `app` (Vite + React). The docs and landing live in `docs` and `site`.

## Prerequisites

- Node 20+.
- Foundry, for the contracts.
- A `.env` at the repo root with testnet-only keys. See `.env.example`. Never commit it.

## Guardian

```bash
cd guardian
npm install
npm run dev          # http://localhost:8787
```

The guardian serves the app's reads and relays, plus the verification service at `/issuer`. Issued codes also land in `guardian/codes.log` as a fallback.

## App

```bash
cd app
npm install
npm run dev          # http://localhost:5173
```

A fresh browser profile lands on onboarding. Use the demo account for a quick tour.

## Health check

Both should return 200.

```bash
curl -s -o /dev/null -w "app %{http_code}\n" http://localhost:5173/
curl -s -o /dev/null -w "issuer %{http_code}\n" http://localhost:8787/issuer
```

If the app shows "Can't reach the guardian service", start the guardian and re-check.

## Contracts

```bash
cd contracts
forge test --fork-url https://sepolia-rpc.giwa.io -j 1
```

The suite forks GIWA Sepolia and runs serially to avoid RPC rate limits. See [The findings](/developers/findings).

## Docs and landing

```bash
cd docs
npm install
npm run docs:build   # outputs to ../site/docs
```

The landing page is static in `site`. The docs build into `site/docs`, so both deploy together from `site`.
