import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CACHE_DIR, findLegacyCacheFile, METADATA_CACHE_PATH } from "./matrix-cache-paths.mjs";

const DEFAULT_TTL_MS = Number.POSITIVE_INFINITY;
const METADATA_CONCURRENCY = 4;

let memoryCachePromise;
let writeQueue = Promise.resolve();
let cacheGeneration = 0;
let cacheEpoch = 0;
const inFlightLoads = new Map();
let tableSearchIndex;
let tableSearchIndexGeneration = -1;

function getCacheType(type) {
  if (type === "databases") return "databases";
  if (type === "tables" || type === "fields") return "tables";
  return "instances";
}

function isCacheEnabled(type) {
  return process.env[`MATRIX_CACHE_${getCacheType(type).toUpperCase()}_ENABLED`] !== "false";
}

function getTtlMs(type = "instances") {
  const rawValue = process.env[`MATRIX_CACHE_${getCacheType(type).toUpperCase()}_TTL_HOURS`]
    ?? process.env.MATRIX_METADATA_CACHE_TTL_HOURS;
  if (/^(0|never|infinite)$/i.test(rawValue || "")) {
    return Number.POSITIVE_INFINITY;
  }
  if (rawValue == null || rawValue === "") {
    return DEFAULT_TTL_MS;
  }
  const hours = Number(rawValue);
  if (!Number.isFinite(hours) || hours <= 0) {
    return DEFAULT_TTL_MS;
  }
  return hours * 60 * 60 * 1000;
}

async function readCacheFile() {
  try {
    return sanitizeCache(JSON.parse(await readFile(METADATA_CACHE_PATH, "utf8")));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const legacyPath = await findLegacyCacheFile("matrix-metadata-cache.json");
      if (!legacyPath) {
        return {};
      }
      const cache = sanitizeCache(JSON.parse(await readFile(legacyPath, "utf8")));
      await writeCacheFile(cache);
      return cache;
    }
    throw error;
  }
}

async function writeCacheFile(cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(METADATA_CACHE_PATH, `${JSON.stringify(sanitizeCache(cache), null, 2)}\n`, "utf8");
}

function getMemoryCache() {
  if (!memoryCachePromise) {
    memoryCachePromise = readCacheFile();
  }
  return memoryCachePromise;
}

function persistCache(cache) {
  writeQueue = writeQueue.catch(() => undefined).then(() => writeCacheFile(cache));
  return writeQueue;
}

async function mapWithConcurrency(items, mapper, concurrency = METADATA_CONCURRENCY) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function makeCacheKey(parts) {
  return parts.map((part) => encodeURIComponent(String(part ?? ""))).join(":");
}

function parseCacheKey(key) {
  return key.split(":").map((part) => decodeURIComponent(part));
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function rankNormalizedMatch(value, keyword) {
  if (!keyword) return 0;
  if (value === keyword) return 100;
  if (value.endsWith(keyword)) return 90;
  if (value.startsWith(keyword)) return 80;
  if (value.includes(keyword)) return 60;
  return -1;
}

function matchesInstancePattern(instance, patterns = []) {
  if (!patterns.length) {
    return true;
  }
  const name = normalizeName(instance.InstanceName || instance.name);
  const id = String(instance.InstanceId || instance.id || "");
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeName(pattern);
    return id === String(pattern) || name.includes(normalizedPattern);
  });
}

function sanitizeCache(cache) {
  const nextCache = {};
  for (const [key, entry] of Object.entries(cache || {})) {
    const [type] = parseCacheKey(key);
    if (type === "envs" || type === "instances") {
      nextCache[key] = {
        ...entry,
        value: Array.isArray(entry?.value) ? entry.value : [],
      };
      continue;
    }
    if (type === "databases" || type === "tables" || type === "fields") {
      nextCache[key] = entry;
    }
  }
  return nextCache;
}

function isCacheEntryFresh(entry, type) {
  return isCacheEnabled(type) && Date.now() - Number(entry?.updatedAt || 0) <= getTtlMs(type);
}

function getTableSearchIndex(cache, baseUrl) {
  if (tableSearchIndex && tableSearchIndexGeneration === cacheGeneration && tableSearchIndex.baseUrl === baseUrl) {
    return tableSearchIndex;
  }
  const instanceNames = new Map();
  const tablesByNormalizedName = new Map();
  for (const [key, entry] of Object.entries(cache)) {
    const [type, entryBaseUrl, instanceId, dbCode] = parseCacheKey(key);
    if (entryBaseUrl !== baseUrl || !isCacheEntryFresh(entry, type)) {
      continue;
    }
    if (type === "instances") {
      for (const instance of entry.value || []) {
        const id = instance.InstanceId || instance.id;
        instanceNames.set(String(id), instance.InstanceName || instance.name || String(id));
      }
      continue;
    }
    if (type !== "tables") {
      continue;
    }
    for (const tableCode of entry.value || []) {
      const normalizedTableCode = normalizeName(tableCode);
      if (!normalizedTableCode) {
        continue;
      }
      const indexed = tablesByNormalizedName.get(normalizedTableCode) || {
        normalizedTableCode,
        tableCode,
        locations: [],
      };
      indexed.locations.push({ instanceId, dbCode });
      tablesByNormalizedName.set(normalizedTableCode, indexed);
    }
  }
  tableSearchIndex = { baseUrl, instanceNames, tablesByNormalizedName };
  tableSearchIndexGeneration = cacheGeneration;
  return tableSearchIndex;
}

async function getOrSet(key, loader, options = {}) {
  const refresh = Boolean(options.refresh);
  const cacheType = options.cacheType || "instances";
  if (!isCacheEnabled(cacheType)) {
    return loader();
  }
  const cache = await getMemoryCache();
  const epoch = cacheEpoch;
  const entry = cache[key];
  if (!refresh && entry && Date.now() - Number(entry.updatedAt || 0) <= getTtlMs(cacheType)) {
    return entry.value;
  }
  if (!inFlightLoads.has(key)) {
    inFlightLoads.set(
      key,
      Promise.resolve()
        .then(loader)
        .then(async (value) => {
          if (epoch !== cacheEpoch) {
            return value;
          }
          cache[key] = {
            updatedAt: Date.now(),
            value,
          };
          cacheGeneration += 1;
          await persistCache(cache);
          return value;
        })
        .finally(() => inFlightLoads.delete(key))
    );
  }
  return inFlightLoads.get(key);
}

export async function clearMetadataCache() {
  cacheGeneration += 1;
  cacheEpoch += 1;
  inFlightLoads.clear();
  memoryCachePromise = Promise.resolve({});
  await persistCache({});
}

export function listCachedEnvironments(client, options = {}) {
  return getOrSet(
    makeCacheKey(["envs", client.baseUrl]),
    () => client.listEnvironments(),
    { ...options, cacheType: "instances" }
  );
}

export function listCachedInstances(client, options = {}) {
  return getOrSet(
    makeCacheKey([
      "instances",
      client.baseUrl,
      options.envCode,
      options.clusterProperty,
      options.needFilter ?? true,
    ]),
    () =>
      client.listInstances({
        envCode: options.envCode,
        clusterProperty: options.clusterProperty,
        needFilter: options.needFilter,
      }),
    { ...options, cacheType: "instances" }
  );
}

export function listCachedDatabases(client, options = {}) {
  return getOrSet(
    makeCacheKey([
      "databases",
      client.baseUrl,
      options.instanceId,
      options.needFilter ?? true,
    ]),
    () =>
      client.listDatabasesWithSplit({
        instanceId: options.instanceId,
        needFilter: options.needFilter,
      }),
    { ...options, cacheType: "databases" }
  );
}

export function listCachedTables(client, instanceId, dbCode, options = {}) {
  return getOrSet(
    makeCacheKey(["tables", client.baseUrl, instanceId, dbCode]),
    () => client.listTables(instanceId, dbCode),
    { ...options, cacheType: "tables" }
  );
}

export function listCachedFields(client, instanceId, dbCode, tableCode, options = {}) {
  return getOrSet(
    makeCacheKey(["fields", client.baseUrl, instanceId, dbCode, tableCode]),
    () => client.listColumns(instanceId, dbCode, tableCode),
    { ...options, cacheType: "tables" }
  );
}

export async function findCachedTables(client, keyword, options = {}) {
  if (!isCacheEnabled("tables")) return [];
  const cache = await getMemoryCache();
  const needle = normalizeName(keyword);
  const index = getTableSearchIndex(cache, client.baseUrl);
  const instanceId = options.instanceId == null ? null : String(options.instanceId);
  const instanceName = options.instanceName ? normalizeName(options.instanceName) : null;
  const dbCode = options.dbCode || null;
  const matches = [];
  for (const indexed of index.tablesByNormalizedName.values()) {
    const score = rankNormalizedMatch(indexed.normalizedTableCode, needle);
    if (score < 0) {
      continue;
    }
    for (const location of indexed.locations) {
      const resolvedInstanceName = index.instanceNames.get(String(location.instanceId)) || String(location.instanceId);
      if (
        (instanceId && String(location.instanceId) !== instanceId) ||
        (instanceName && normalizeName(resolvedInstanceName) !== instanceName) ||
        (dbCode && location.dbCode !== dbCode)
      ) {
        continue;
      }
      matches.push({
        instanceId: Number(location.instanceId) || location.instanceId,
        instanceName: resolvedInstanceName,
        dbCode: location.dbCode,
        tableCode: indexed.tableCode,
        score,
      });
    }
  }
  matches.sort(
    (left, right) =>
      right.score - left.score ||
      left.dbCode.localeCompare(right.dbCode) ||
      left.tableCode.localeCompare(right.tableCode)
  );
  return matches.slice(0, options.limit || 100).map(({ score, ...match }) => match);
}

export async function warmMetadataCache(client, options = {}) {
  const envs = await listCachedEnvironments(client, { refresh: options.refresh });
  const targetEnvCodes = options.envCode
    ? new Set([options.envCode])
    : new Set(envs.map((env) => env.envCode).filter(Boolean));
  const summary = {
    envs: envs.length,
    instances: 0,
    skippedInstances: 0,
    databases: 0,
    tables: 0,
    fields: 0,
    skippedEnvs: 0,
    warmedInstances: [],
  };
  const instancePatterns =
    options.instancePatterns === null
      ? []
      : options.instancePatterns?.length
        ? options.instancePatterns
        : [];

  const selectedEnvs = envs.filter((env) => targetEnvCodes.has(env.envCode));
  summary.skippedEnvs = envs.length - selectedEnvs.length;
  const instanceGroups = await mapWithConcurrency(selectedEnvs, async (env) => {
    const instances = await listCachedInstances(client, {
      envCode: env.envCode,
      clusterProperty: options.clusterProperty,
      refresh: options.refresh,
    });
    const scopedInstances = options.maxInstances ? instances.slice(0, options.maxInstances) : instances;
    const targetInstances = scopedInstances.filter(
      (instance) => matchesInstancePattern(instance, instancePatterns) && (options.allInstances || isTargetInstance(instance))
    );
    return { scopedInstances, targetInstances };
  });
  const targetInstances = instanceGroups.flatMap(({ scopedInstances, targetInstances: matches }) => {
    summary.instances += matches.length;
    summary.skippedInstances += scopedInstances.length - matches.length;
    return matches;
  });
  summary.warmedInstances = targetInstances.map((instance) => {
    const instanceId = instance.InstanceId || instance.id;
    return { instanceId, instanceName: instance.InstanceName || instance.name || String(instanceId) };
  });

  const databaseGroups = await mapWithConcurrency(targetInstances, async (instance) => {
    const instanceId = instance.InstanceId || instance.id;
    const databases = await listCachedDatabases(client, { instanceId, refresh: options.refresh });
    return {
      instanceId,
      databases: options.maxDatabases ? databases.slice(0, options.maxDatabases) : databases,
    };
  });
  const databaseScopes = databaseGroups.flatMap(({ instanceId, databases }) => {
    summary.databases += databases.length;
    return databases
      .map((database) => ({ instanceId, dbCode: typeof database === "string" ? database : database?.dbCode }))
      .filter(({ dbCode }) => Boolean(dbCode));
  });
  if (!options.includeTables && !options.includeFields) {
    return summary;
  }

  const tableGroups = await mapWithConcurrency(databaseScopes, async ({ instanceId, dbCode }) => ({
    instanceId,
    dbCode,
    tables: await listCachedTables(client, instanceId, dbCode, { refresh: options.refresh }),
  }));
  const tableScopes = tableGroups.flatMap(({ instanceId, dbCode, tables }) => {
    const scopedTables = options.maxTables ? tables.slice(0, options.maxTables) : tables;
    summary.tables += scopedTables.length;
    return scopedTables.map((tableCode) => ({ instanceId, dbCode, tableCode }));
  });
  if (!options.includeFields) {
    return summary;
  }

  const fields = await mapWithConcurrency(tableScopes, ({ instanceId, dbCode, tableCode }) =>
    listCachedFields(client, instanceId, dbCode, tableCode, { refresh: options.refresh })
  );
  summary.fields = fields.reduce((count, columns) => count + columns.length, 0);

  return summary;
}
