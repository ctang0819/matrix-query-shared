import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCacheDir, getProfile, readSettings, saveProfiles } from "./profile-store.mjs";
import { createAuthenticatedClient } from "./matrix-session-cache.mjs";
import { warmMetadataCache } from "./matrix-metadata-cache.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = await readFile(path.join(ROOT, "ui", "config.html"));
const MAX_BODY = 1024 * 1024;

function allowedRequest(request) {
  const host = request.headers.host || "";
  const origin = request.headers.origin;
  return ["127.0.0.1", "localhost"].includes(host.split(":")[0]) &&
    (!origin || origin === `http://${host}`);
}

function send(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
  });
  response.end(body);
}

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new Error("Request body too large.");
  }
  return JSON.parse(raw || "{}");
}

function publicProfile(id, profile) {
  return {
    ...profile,
    id,
    credentials: { username: profile.credentials?.username || "", password: "", hasPassword: Boolean(profile.credentials?.password) },
    proxy: { ...profile.proxy, password: "", hasPassword: Boolean(profile.proxy?.password) },
  };
}

const server = createServer(async (request, response) => {
  if (!allowedRequest(request)) return send(response, 403, JSON.stringify({ error: "Local access only." }));
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/") return send(response, 200, PAGE, "text/html; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/api/config") {
    const { profiles, slots } = await readSettings();
    return send(response, 200, JSON.stringify({ profiles: Object.entries(profiles).map(([id, profile]) => publicProfile(id, profile)), slots }));
  }
  if (request.method === "PUT" && url.pathname === "/api/config") {
    try {
      const body = await readBody(request);
      const { profiles: previous } = await readSettings();
      const profiles = {};
      for (const item of body.profiles || []) {
        const id = String(item.id || "").trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error(`Invalid profile id: ${id}`);
        const baseUrl = new URL(item.baseUrl);
        if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("Endpoint must use HTTP or HTTPS.");
        const old = previous[id] || {};
        profiles[id] = {
          name: String(item.name || id).trim() || id,
          hospital: String(item.hospital || item.name || id).trim() || id,
          baseUrl: baseUrl.origin,
          envCode: String(item.envCode || "").trim(),
          defaultInstanceName: String(item.defaultInstanceName || "").trim(),
          defaultInstanceId: Number(item.defaultInstanceId || 0) || undefined,
          defaultDbCode: String(item.defaultDbCode || "").trim(),
          clusterProperty: String(item.clusterProperty || "mysql").trim() || "mysql",
          credentials: {
            username: String(item.credentials?.username || "").trim(),
            password: item.credentials?.password || old.credentials?.password || "",
          },
          proxy: {
            scheme: String(item.proxy?.scheme || "socks5h").trim(),
            host: String(item.proxy?.host || "").trim(),
            port: Number(item.proxy?.port || 0) || undefined,
            username: String(item.proxy?.username || "").trim(),
            password: item.proxy?.password || old.proxy?.password || "",
          },
          cacheDir: item.cacheDir ? path.resolve(String(item.cacheDir).trim()) : defaultCacheDir(id),
          sessionTtlHours: Number(item.sessionTtlHours ?? 12),
          locateInstances: Array.isArray(item.locateInstances) ? item.locateInstances.map(String) : [],
          aliases: item.aliases || {},
        };
      }
      const slots = {};
      for (const slot of ["hnxk", "wz", "zy"]) {
        const profileId = String(body.slots?.[slot] || "");
        slots[slot] = profileId && profiles[profileId] ? profileId : "";
      }
      await saveProfiles(profiles, slots);
      return send(response, 200, JSON.stringify({ ok: true, profiles: Object.keys(profiles).length, slots }));
    } catch (error) {
      return send(response, 400, JSON.stringify({ error: error.message || "Configuration could not be saved." }));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/test") {
    try {
      const { profileId } = await readBody(request);
      const profile = await getProfile(profileId);
      const client = await createAuthenticatedClient({
        username: profile.credentials?.username,
        password: profile.credentials?.password,
        baseUrl: profile.baseUrl,
        proxy: profile.proxy,
      });
      return send(response, 200, JSON.stringify({ ok: true, user: client.userInfo?.name || client.userInfo?.username || "connected" }));
    } catch (error) {
      return send(response, 502, JSON.stringify({ ok: false, error: error.message || "Connection test failed." }));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/cache/refresh") {
    try {
      const { profileId } = await readBody(request);
      const profile = await getProfile(profileId);
      const client = await createAuthenticatedClient({ username: profile.credentials?.username, password: profile.credentials?.password, baseUrl: profile.baseUrl, proxy: profile.proxy });
      const summary = await warmMetadataCache(client, { envCode: profile.envCode || undefined, instancePatterns: null, allInstances: true, includeTables: true, refresh: true });
      return send(response, 200, JSON.stringify({ ok: true, summary }));
    } catch (error) {
      return send(response, 502, JSON.stringify({ ok: false, error: error.message || "全量刷新元数据失败。" }));
    }
  }
  if (request.method === "POST" && url.pathname === "/api/options") {
    try {
      const { profileId, envCode, clusterProperty = "mysql", instanceId } = await readBody(request);
      const profile = await getProfile(profileId);
      const client = await createAuthenticatedClient({
        username: profile.credentials?.username,
        password: profile.credentials?.password,
        baseUrl: profile.baseUrl,
        proxy: profile.proxy,
      });
      const environments = await client.listEnvironments();
      const effectiveEnvCode = environments.some((item) => item.envCode === envCode)
        ? envCode
        : environments.find((item) => item.envCode === profile.envCode)?.envCode || "";
      const instances = effectiveEnvCode
        ? await client.listInstances({ envCode: effectiveEnvCode, clusterProperty })
        : [];
      const databases = instanceId
        ? await client.listDatabasesWithSplit({ instanceId })
        : [];
      return send(response, 200, JSON.stringify({ environments, envCode: effectiveEnvCode, instances, databases }));
    } catch (error) {
      return send(response, 502, JSON.stringify({ error: error.message || "读取 Matrix 选项失败。" }));
    }
  }
  send(response, 404, JSON.stringify({ error: "Not found." }));
});

const requestedPort = Number(process.env.MATRIX_CONFIG_PORT || 4178);
server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`Matrix configuration page: http://127.0.0.1:${address.port}\n`);
});
