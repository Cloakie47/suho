import { initDb, closeDb } from "./db.js";

/// Create/verify the Phase H schema. Run once after DATABASE_URL is set:
///   npm run db:init
await initDb();
console.log("suho: schema ready (accounts, email_events, ops_audit, tx_messages, message_blocks)");
await closeDb();
