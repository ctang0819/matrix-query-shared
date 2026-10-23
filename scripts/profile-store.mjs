import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROFILE_PATH = path.join(ROOT, "config", "profiles.json");
const DEFAULT_CACHE_ROOT = path.join(os.homedir(), ".codex", "matrix-query", "cache");

export async function readSettings() {
  try {
    const data = JSON.parse(await readFile(PROFILE_PATH, "utf8"));
    return {
      profiles: data.profiles && typeof data.profiles === "object" ? data.profiles : {},
      slots: data.slots && typeof data.slots === "object" ? data.slots : {},
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { profiles: {}, slots: {} };
    throw error;
  }
}

export async function readProfiles() {
  return (await readSettings()).profiles;
}

export async function getProfile(id = process.env.MATRIX_PROFILE_ID || "zy") {
  const profiles = await readProfiles();
  const profile = profiles[id];
  if (!profile) throw new Error(`Matrix profile not configured: ${id}`);
  return { id, ...profile };
}

export async function saveProfiles(profiles, slots = {}) {
  await mkdir(path.dirname(PROFILE_PATH), { recursive: true, mode: 0o700 });
  let existingSlots = {};
  try {
    existingSlots = JSON.parse(await readFile(PROFILE_PATH, "utf8")).slots || {};
  } catch {}
  const mergedSlots = {
    hnxk: "hnxk",
    wz: "wz",
    zy: "zy",
    ...existingSlots,
    ...slots,
  };
  for (const [slot, profileId] of Object.entries(mergedSlots)) {
    if (profileId && !profiles[profileId]) delete mergedSlots[slot];
  }
  await writeFile(PROFILE_PATH, `${JSON.stringify({ profiles, slots: mergedSlots }, null, 2)}\n`, { mode: 0o600 });
  await chmod(PROFILE_PATH, 0o600);
}

export function defaultCacheDir(id) {
  return path.join(DEFAULT_CACHE_ROOT, id);
}
