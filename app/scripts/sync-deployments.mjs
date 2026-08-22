// Copies the canonical on-chain addresses from contracts/deployments into the
// app source tree so config.ts can DERIVE its Ondol wiring from a single source
// of truth. Runs on `predev` and `prebuild`. Prevents the class of bug where a
// redeployed contract (e.g. the guard) updates deployments but a hardcoded app
// constant silently drifts — which broke onboarding (Init signature mismatch).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../contracts/deployments/giwa-sepolia.json");
const dst = resolve(here, "../src/deployments.json");

// Resilient: if the canonical file isn't in the build context (a host that
// prunes the monorepo to app/), keep the committed app/src/deployments.json and
// exit 0 so prebuild never fails. Cloudflare Pages clones the full repo, so this
// normally syncs fresh; the guard is insurance against a pruning host.
if (!existsSync(src)) {
  console.log(`sync-deployments: source not present (${src}); keeping committed app/src/deployments.json`);
  process.exit(0);
}
const d = JSON.parse(readFileSync(src, "utf8"));
// Only the fields the app needs; keep it a small, explicit surface.
const out = {
  chainId: d.chainId,
  ondolTransferGuard: d.ondolTransferGuard,
  ondolSpendingGuard: d.ondolSpendingGuard, // bank-model limits guard (new default)
  ariseModule: d.ariseModule,
  ondolProxy: d.ondolProxy,
  ondolAccountV3Impl: d.ondolAccountV3Impl,
  ondolAccountV2Impl: d.ondolAccountV2Impl,
  ondolAccountImpl: d.ondolAccountImpl, // v1 (legacy) — a valid delegation target
  ondolAccountV4Impl: d.ondolAccountV4Impl, // Phase SEC 2.3: email second-factor impl
  ondolAccountV5Impl: d.ondolAccountV5Impl, // Horizon 1 S1.1: ERC-1271 (dApp sign-in) impl
  suhoCodeAttester: d.suhoCodeAttester,
  suhoMemo: d.suhoMemo, // Phase M: on-chain memo log (batched into execute)
};
for (const [k, v] of Object.entries(out)) {
  if (v === undefined) throw new Error(`deployments is missing "${k}" — cannot sync app wiring`);
}
writeFileSync(dst, JSON.stringify(out, null, 2) + "\n");
console.log(`synced app/src/deployments.json (guard ${out.ondolTransferGuard})`);
