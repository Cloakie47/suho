import { readFile, writeFile } from "node:fs/promises";

// Deploy-time injection for the landing's Launch-app URL. The committed HTML uses
// the local dev app (http://localhost:5173/); at build set SUHO_APP_URL (or
// VITE_APP_URL) to the deployed app and this rewrites every occurrence. Run from
// the static host's build step, e.g.  node inject-config.mjs
const APP_URL = process.env.SUHO_APP_URL || process.env.VITE_APP_URL;
if (!APP_URL) {
  console.log("inject-config: no SUHO_APP_URL/VITE_APP_URL set — leaving the localhost dev default");
  process.exit(0);
}
const file = new URL("./index.html", import.meta.url);
const html = await readFile(file, "utf8");
const out = html.replaceAll("http://localhost:5173/", APP_URL);
await writeFile(file, out);
const n = html.split("http://localhost:5173/").length - 1;
console.log(`inject-config: Launch app -> ${APP_URL} (${n} link${n === 1 ? "" : "s"})`);
