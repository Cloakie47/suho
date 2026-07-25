import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/// Central env bootstrap (import for its side effect). guardian/.env holds the
/// guardian's own config (Phase H) and matches the Railway service root; the
/// repo-root .env holds the relayer/demo keys. Load both; dotenv never overrides
/// already-set vars, so on Railway (no files) the dashboard vars win. Loaded
/// guardian/.env first so it takes precedence locally.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env") });
dotenv.config({ path: path.resolve(here, "../../.env") });
