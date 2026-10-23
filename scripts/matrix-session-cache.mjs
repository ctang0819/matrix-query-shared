import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CACHE_DIR, findLegacyCacheFiles, SESSION_CACHE_PATH } from "./matrix-cache-paths.mjs";
import { MatrixClient } from "./matrix-client.mjs";

function getSessionTtlMs() {
  const value = Number(process.env.MATRIX_SESSION_CACHE_TTL_HOURS || 12);
  return value <= 0 ? Number.POSITIVE_INFINITY : value * 60 * 60 * 1000;
}

function makeCacheKey({ baseUrl, username }) {
  return crypto
    .createHash("sha1")
    .update(`${baseUrl}::${username}`)
    .digest("hex");
}

async function readCacheFile() {
  try {
    return JSON.parse(await readFile(SESSION_CACHE_PATH, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const cache = await readLegacySessionCache();
      if (!Object.keys(cache).length) {
        return {};
      }
      await writeCacheFile(cache);
      return cache;
    }
    throw error;
  }
}

async function writeCacheFile(cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(SESSION_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function mergeSessionCaches(caches) {
  const merged = {};
  for (const cache of caches) {
    for (const [key, entry] of Object.entries(cache || {})) {
      if (Number(entry?.updatedAt || 0) > Number(merged[key]?.updatedAt || 0)) {
        merged[key] = entry;
      }
    }
  }
  return merged;
}

async function readLegacySessionCache() {
  const paths = await findLegacyCacheFiles("matrix-session-cache.json");
  const caches = await Promise.all(
    paths.map(async (filePath) => {
      try {
        return JSON.parse(await readFile(filePath, "utf8"));
      } catch {
        return {};
      }
    })
  );
  return mergeSessionCaches(caches);
}

function isFresh(entry) {
  return Date.now() - Number(entry?.updatedAt || 0) <= getSessionTtlMs();
}

async function loadCachedSession({ baseUrl, username }) {
  const cache = await readCacheFile();
  const key = makeCacheKey({ baseUrl, username });
  const entry = cache[key];
  if (!entry) {
    return null;
  }
  if (!isFresh(entry)) {
    return null;
  }
  return entry.session || null;
}

async function loadAnyCachedSession({ baseUrl }) {
  const cache = await readCacheFile();
  const candidates = Object.values(cache)
    .filter((entry) => entry?.session?.baseUrl === baseUrl && entry?.session?.token && isFresh(entry))
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  if (candidates[0]?.session) {
    return candidates[0].session;
  }

  // A stale stable cache must not hide a still-valid session from an older plugin version.
  const legacyCache = await readLegacySessionCache();
  const legacyCandidates = Object.values(legacyCache)
    .filter((entry) => entry?.session?.baseUrl === baseUrl && entry?.session?.token && isFresh(entry))
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  if (!legacyCandidates[0]?.session) {
    return null;
  }
  await writeCacheFile(mergeSessionCaches([cache, legacyCache]));
  return legacyCandidates[0].session;
}

async function saveCachedSession({ baseUrl, username, client }) {
  const cache = await readCacheFile();
  const key = makeCacheKey({ baseUrl, username });
  cache[key] = {
    updatedAt: Date.now(),
    session: client.exportSession(),
  };
  await writeCacheFile(cache);
}

async function clearCachedSession({ baseUrl, username }) {
  const cache = await readCacheFile();
  const key = makeCacheKey({ baseUrl, username });
  if (cache[key]) {
    delete cache[key];
    await writeCacheFile(cache);
  }
}

export async function createAuthenticatedClient({
  username,
  password,
  baseUrl,
  proxy,
}) {
  const client = new MatrixClient({ baseUrl, proxy });
  if (!username || !password) {
    const cachedSession = await loadAnyCachedSession({ baseUrl: client.baseUrl });
    if (cachedSession) {
      client.importSession(cachedSession);
      try {
        const userInfo = await client.getLoginUserInfo();
        if (userInfo?.success) {
          return client;
        }
      } catch {}
    }
    throw new Error("Missing username/password and no valid cached Matrix session was found.");
  }

  const cachedSession = await loadCachedSession({
    baseUrl: client.baseUrl,
    username,
  });

  if (cachedSession) {
    client.importSession(cachedSession);
    try {
      const userInfo = await client.getLoginUserInfo();
      if (userInfo?.success) {
        await saveCachedSession({
          baseUrl: client.baseUrl,
          username,
          client,
        });
        return client;
      }
    } catch {}
    await clearCachedSession({ baseUrl: client.baseUrl, username });
  }

  await client.login({ username, password });
  await client.getLoginUserInfo();
  await saveCachedSession({
    baseUrl: client.baseUrl,
    username,
    client,
  });
  return client;
}
