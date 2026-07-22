# Directory

The Directory is the trust surface. It lists verified humans with active up.id names. An unverified address cannot appear in it by construction.

## What it shows

Each row is a verified name: a red seal, the up.id name, and a truncated address. Your own row is marked. Hover a row to reveal a Send button that opens the Send screen with the recipient prefilled.

Search is server-side. The registry holds tens of thousands of names, so the guardian filters and returns a capped list per query.

## How it stays honest

The guardian builds the list from on-chain registration events. Every entry is checked at read time against two conditions: the name has an owner, and that owner has an active name. Both checks read live state, so a revoked or expired name drops out even though its registration event remains.

The registry has two traps that the guardian handles. It returns the zero address for unregistered names instead of reverting. And it reports an active name for the zero address. Both are rejected explicitly. See [The findings](/developers/findings).
