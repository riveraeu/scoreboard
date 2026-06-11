// Shared MLB constants + helpers used by mlb.js / mlb-hitters.js / mlb-pitchers.js.
// Leaf module (no imports beyond utils.js) so the builder files can depend on it
// without creating an import cycle back through mlb.js.
import { fetchSafe } from "./utils.js";

export const _fs = (label, url, opts) => fetchSafe(`mlb:${label}`, url, opts);

// MLB Stats API teamId → canonical abbreviation. Derived from the team registry
// (api/lib/teams.js) since 2026-06-11; re-exported here for the historical import path.
import { MLB_ID_TO_ABBR } from "./teams.js";
export { MLB_ID_TO_ABBR };
