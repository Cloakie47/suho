// Vendors the canonical on-chain addresses from contracts/deployments into the
// guardian so it works under Railway's monorepo build, where root=guardian
// prunes contracts/ out of the deploy context. contracts.ts reads the committed
// guardian/src/deployments.json (always present in the pruned context); this
// script keeps that copy fresh from the source of truth.
//
// Resilient by design: if the source isn't reachable (e.g. running inside the
// pruned Railway context), it leaves the committed copy untouched and exits 0 —
// so predev/prestart never fail on Railway. Locally the source IS present, so a
// contract redeploy that updates contracts/deployments flows through on the next
// `npm run dev` / `npm start`.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../contracts/deployments/giwa-sepolia.json");
const dst = resolve(here, "../src/deployments.json");

if (!existsSync(src)) {
  console.log(`sync-deployments: source not present (${src}); keeping committed guardian/src/deployments.json`);
  process.exit(0);
}
const data = JSON.parse(readFileSync(src, "utf8"));
writeFileSync(dst, JSON.stringify(data, null, 2) + "\n");
console.log(`sync-deployments: guardian/src/deployments.json updated (guard ${data.ondolTransferGuard})`);
