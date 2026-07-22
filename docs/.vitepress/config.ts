import { defineConfig } from "vitepress";

// The app is a SEPARATE origin from the docs. "Launch app" must be an absolute
// URL to the app, not a path relative to /docs/ (which would land on the
// landing page). Env-configurable: set SUHO_APP_URL at build time to the
// deployed app URL; defaults to the local Vite dev server.
const APP_URL = process.env.SUHO_APP_URL || "http://localhost:5173/";

// Built to ../site/docs so the landing (site/index.html) and the docs deploy
// together. Served at /docs/. Only the docs specs are VitePress sources; the
// deployment notes, demo script, and README stay as their own files.
export default defineConfig({
  title: "Suho Docs",
  description:
    "A wallet that guards you on GIWA. Send to names, recover without a seed phrase, live on GIWA Sepolia.",
  lang: "en",
  base: "/docs/",
  outDir: "../site/docs",
  cleanUrls: true,
  srcExclude: [
    "deployments.md",
    "demo-script.md",
    "suho-phase-*.md",
    "suho-app-spec.md",
    "suho-addendum-spec.md",
    "suho-attestation-layer-spec.md",
  ],
  head: [
    ["link", { rel: "preconnect", href: "https://api.fontshare.com", crossorigin: "" }],
    ["link", { rel: "preconnect", href: "https://cdn.jsdelivr.net", crossorigin: "" }],
    [
      "link",
      { rel: "stylesheet", href: "https://api.fontshare.com/v2/css?f[]=general-sans@500,600&display=swap" },
    ],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css",
      },
    ],
    [
      "link",
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap" },
    ],
  ],
  themeConfig: {
    nav: [
      { text: "Overview", link: "/overview/what-is-suho" },
      { text: "Using Suho", link: "/using/create-account" },
      { text: "Under the hood", link: "/internals/ondol-account" },
      { text: "Developers", link: "/developers/contracts" },
      { text: "Launch app", link: APP_URL, target: "_blank" },
    ],
    sidebar: [
      {
        text: "Overview",
        items: [
          { text: "What is Suho", link: "/overview/what-is-suho" },
          { text: "Architecture", link: "/overview/architecture" },
        ],
      },
      {
        text: "Using Suho",
        items: [
          { text: "Create an account", link: "/using/create-account" },
          { text: "Send and the guard", link: "/using/send" },
          { text: "Your Card", link: "/using/card" },
          { text: "Directory", link: "/using/directory" },
          { text: "Arise recovery", link: "/using/arise" },
          { text: "Accounts on this device", link: "/using/accounts" },
        ],
      },
      {
        text: "Under the hood",
        items: [
          { text: "The Ondol account", link: "/internals/ondol-account" },
          { text: "Dojang and attesters", link: "/internals/dojang" },
          { text: "Verified codes and the issuer", link: "/internals/codes" },
          { text: "Custody and threat model", link: "/internals/custody" },
        ],
      },
      {
        text: "Developers",
        items: [
          { text: "Contracts and addresses", link: "/developers/contracts" },
          { text: "The findings", link: "/developers/findings" },
          { text: "Running locally", link: "/developers/running" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/Cloakie47/suho" }],
    outline: { level: [2, 3] },
    search: { provider: "local" },
  },
});
