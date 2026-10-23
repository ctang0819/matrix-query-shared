import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProfile } from "./profile-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const aliasesCache = new Map();

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function loadAliases(profileId = process.env.MATRIX_PROFILE_ID || "zy") {
  if (!aliasesCache.has(profileId)) {
    const profile = await getProfile(profileId);
    const aliases = profile.aliases || (await readJsonIfExists(path.join(ROOT_DIR, "config", `matrix-aliases-${profileId}.json`))) || {
      instanceAliases: {},
      databaseAliases: {},
      databasePreferredInstances: {},
    };
    aliasesCache.set(profileId, aliases);
  }
  return aliasesCache.get(profileId);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function pickExactKey(map, value) {
  const target = normalize(value);
  for (const [key, resolved] of Object.entries(map || {})) {
    if (normalize(key) === target) {
      return resolved;
    }
  }
  return null;
}

export async function resolveInstanceTarget(client, options = {}) {
  const profileId = options.profileId || process.env.MATRIX_PROFILE_ID || "zy";
  const profile = await getProfile(profileId);
  const aliases = await loadAliases(profileId);
  const explicitInstanceId = Number(options.instanceId || 0);
  if (explicitInstanceId) {
    return {
      instanceId: explicitInstanceId,
      instanceName: options.instanceName || null,
      envCode: options.envCode || null,
      databases: [],
      source: "explicit-id",
    };
  }

  const requestedDbCode = options.dbCode || "";
  const aliasResolvedDbCode =
    pickExactKey(aliases.databaseAliases, requestedDbCode) || requestedDbCode;
  const preferredInstanceName =
    pickExactKey(aliases.databasePreferredInstances, aliasResolvedDbCode) ||
    aliases.databasePreferredInstances?.[aliasResolvedDbCode] ||
    null;
  if (preferredInstanceName) {
    const cluster = await client.findClusterByName(preferredInstanceName);
    if (cluster) {
      return {
        instanceId: cluster.id,
        instanceName: cluster.name,
        envCode: options.envCode || null,
        databases: [],
        source: "preferred-db-instance",
      };
    }
  }

  const requestedName = options.instanceName || profile.defaultInstanceName || "";
  const aliasResolvedName =
    pickExactKey(aliases.instanceAliases, requestedName) || requestedName;

  if (aliasResolvedName) {
    const cluster = await client.findClusterByName(aliasResolvedName);
    if (!cluster && options.instanceName) {
      throw new Error(`Cluster not found: ${requestedName || aliasResolvedName}`);
    }
    if (cluster) {
      return {
        instanceId: cluster.id,
        instanceName: cluster.name,
        envCode: options.envCode || profile.envCode || null,
        databases: [],
        source: requestedName && requestedName !== cluster.name ? "alias-remote" : "remote",
      };
    }
  }

  return {
    instanceId: Number(profile.defaultInstanceId || 1),
    instanceName: profile.defaultInstanceName || null,
    envCode: options.envCode || profile.envCode || null,
    databases: [],
    source: "default",
  };
}

export async function resolveDatabaseCode(options = {}) {
  const profileId = options.profileId || process.env.MATRIX_PROFILE_ID || "zy";
  const profile = await getProfile(profileId);
  const aliases = await loadAliases(profileId);
  const requestedCode = options.dbCode || profile.defaultDbCode || "oc";
  return pickExactKey(aliases.databaseAliases, requestedCode) || requestedCode;
}

export async function loadMatrixAliases() {
  return loadAliases();
}
