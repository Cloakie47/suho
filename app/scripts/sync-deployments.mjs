// Copies the canonical on-chain addresses from contracts/deployments into the
// app source tree so config.ts can DERIVE its Ondol wiring from a single source
// of truth. Runs on `predev` and `prebuild`. Prevents the class of bug where a
// redeployed contract (e.g. the guard) updates deployments but a hardcoded app
// constant silently drifts — which broke onboarding (Init signature mismatch).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../contracts/deployments/giwa-sepolia.json");
const dst = resolve(here, "../src/deployments.json");

const d = JSON.parse(readFileSync(src, "utf8"));
// Only the fields the app needs; keep it a small, explicit surface.
const out = {
  chainId: d.chainId,
  ondolTransferGuard: d.ondolTransferGuard,
  ariseModule: d.ariseModule,
  ondolProxy: d.ondolProxy,
  ondolAccountV3Impl: d.ondolAccountV3Impl,
  ondolAccountV2Impl: d.ondolAccountV2Impl,
  suhoCodeAttester: d.suhoCodeAttester,
};
for (const [k, v] of Object.entries(out)) {
  if (v === undefined) throw new Error(`deployments is missing "${k}" — cannot sync app wiring`);
}
writeFileSync(dst, JSON.stringify(out, null, 2) + "\n");
console.log(`synced app/src/deployments.json (guard ${out.ondolTransferGuard})`);
