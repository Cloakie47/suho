# Suho — Demo Script (stage directions)

## Pre-flight (before anyone is watching)

1. **Windows to have open:**
   - Projector main: browser at `http://localhost:5173` (app).
   - Second terminal, visible: the guardian console, retitled **"UPBIT
     VERIFICATION SERVICE"** — this is the code-delivery theater. Backup if the
     window is lost: `Get-Content -Wait guardian\codes.log`.
   - Hidden: the vite terminal.
2. **Explorer tabs to pre-open** (sepolia-explorer.giwa.io):
   - alice's address page — the `0xef0100…` code is visible under "Contract".
   - one SuhoCodeAttester attestation (any issued code).
   - the arise() transaction.
3. **Checks:** app's Send screen shows **no amber headroom chip** (alice funded
   ≥ ~0.015 ETH; top up from Rabby if it shows). Guardian console shows
   `directory prewarmed: N active names`. Both RPCs answering.
4. Have the Windows Hello PIN/fingerprint ready. All sends need it.

## Act 1 — "Same address, same name, new powers" (Upgrade screen)

- Show the wallet: **alice.up.id**, red seal, balance. "This is a normal
  verified Upbit-ecosystem account. One transaction makes it a smart account —
  without changing the address or losing the name."
- (Already upgraded in advance.) Point at the success card → click the explorer
  link → show the `0xef0100…` delegation code on-chain. "The EOA key is now in
  a drawer. From here, everything is passkey-signed."

## Act 2 — Send to a verified human (Send screen)

- Type `suho` in the recipient field → it live-resolves: **big seal, "Verified
  human", Dojang attestation**. "The wallet knows who this is."
- Send 0.0002 → Windows Hello → watch the pending state → **"confirmed in
  ~XXXms"** — real measured number, Flashblocks preconfirmation. Mention it.

## Act 3 — The stranger (mallory's moment)

- Paste mallory's address `0xB53A…B0B2` → amber card: **"Unverified address —
  Suho can't identify who this is."**
- Send 0.0005 anyway → goes through (small amounts warn, not block).
- Now send **0.011** → the **OTP interstitial** appears. Turn to the
  "verification service" terminal — the 6-digit code is on screen. Type it →
  Verify & send → success. "Large transfers to strangers need a code delivered
  out-of-band. A drainer in your browser can't produce it, and the code is
  cryptographically bound to THIS recipient and THIS amount."

## Act 4 — Directory (the trust surface)

- Open **Directory**: N verified names, every row a seal. "Only active,
  Dojang-verified humans can appear here — by construction."
- Search `alice` → her row has the "· you" marker. Search `suho` → click
  **Send** → the Send screen opens prefilled and resolving. (No need to send.)

## Act 5 — Suho Card (attested identity)

- Open **Card** → show the card: seal, alice.up.id, display name, contact,
  QR, version line, and the small print: *"Identity verified by Dojang. Card
  details are self-declared by the verified owner."* Read it out — honesty is
  the feature.
- Click **Edit card** → change remarks → **Sign & update** → Windows Hello →
  "one signature attested v2 AND revoked v1, atomically. Nothing deleted."
- Open **History** → v1 shows its revocation timestamp, v2 is current.
- Open the share link `#/verify/<alice>` in a fresh incognito window — the
  read-only verification view loads with no session, no passkey.

## Act 6 — Arise (deliberately theatrical)

- "Alice's phone is gone. Watch what does NOT happen: no seed phrase, no
  support ticket, no new address."
- **Arise** screen → *Create new passkey* (Hello prompt — "this is the new
  device") → *Request recovery code* → read it off the verification-service
  terminal → type it → **Arise** → "You have risen. Same address, same name,
  new key." Show measured ms.
- **Prove it**: "Try old passkey" → fails with `InvalidPasskeySignature` (red).
  "Send with new passkey" → succeeds (green). Point at the arise() tx in the
  pre-opened explorer tab.

## Fallbacks

- **RPC slow / receipt lag:** timings may stretch; the UI keeps polling for
  30 s. If a status read looks stale, wait 2–3 s and let it re-poll (the
  guardian reads twice by design).
- **Windows Hello cancel/timeout:** the send shows the error state; just click
  Send again.
- **OTP expired** (10-min window): trigger the send again — a fresh code is
  issued and the old one is dead.
- **Directory empty / canary error:** the RPC served incomplete logs; hit
  refresh on the Directory screen (it rescans and refuses to show a partial
  list rather than a wrong one).
- **Total RPC outage:** fall back to the pre-opened explorer tabs and the
  38-green fork tests; the story survives on receipts.
