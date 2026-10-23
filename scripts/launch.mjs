import { getProfile, readSettings } from "./profile-store.mjs";

const slot = process.argv[2] || process.env.MATRIX_PROFILE_SLOT || "zy";
const { slots } = await readSettings();
const profileId = slots[slot] || slot;
const profile = await getProfile(profileId);

process.env.MATRIX_PROFILE_ID = profileId;
process.env.MATRIX_TOOL_PREFIX = slot;
process.env.MATRIX_CACHE_DIR = profile.cacheDir;
for (const type of ["instances", "databases", "tables"]) {
  const suffix = type.toUpperCase();
  process.env[`MATRIX_CACHE_${suffix}_ENABLED`] = "true";
  process.env[`MATRIX_CACHE_${suffix}_TTL_HOURS`] = "0";
}
process.env.MATRIX_SESSION_CACHE_TTL_HOURS = String(profile.sessionTtlHours ?? 12);

await import("./matrix-mcp-server.mjs");
