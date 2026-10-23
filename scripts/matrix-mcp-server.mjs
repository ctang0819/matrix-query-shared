import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProfile, readSettings } from "./profile-store.mjs";
import { createAuthenticatedClient } from "./matrix-session-cache.mjs";
import { MatrixQueryError } from "./matrix-client.mjs";
import {
  clearMetadataCache,
  findCachedTables,
  listCachedDatabases,
  listCachedEnvironments,
  listCachedFields,
  listCachedInstances,
  listCachedTables,
  warmMetadataCache,
} from "./matrix-metadata-cache.mjs";
import {
  resolveDatabaseCode,
  resolveInstanceTarget,
} from "./matrix-target-resolver.mjs";

const PROFILE_ID = process.env.MATRIX_PROFILE_ID || "zy";
const TOOL_PREFIX = process.env.MATRIX_TOOL_PREFIX || PROFILE_ID;
const DEFAULT_ENV_CODE = (await getProfile(PROFILE_ID)).envCode;
const DEFAULT_CLUSTER_PROPERTY = "mysql";
const DEFAULT_QUERY_LIMIT = 200;
const MAX_QUERY_LIMIT = 1000;
const SEARCH_CONCURRENCY = 4;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCATE_CONFIG_PATH = path.join(__dirname, "..", "config", "locate-instances.json");
const DEFAULT_LOCATE_INSTANCES = [
  "余杭生产HIS数据库",
  "his-drds",
  "his-adb",
  "三方-adb",
  "三方-adb-new(余杭)",
  "hbos",
  "bingo",
  "生产redis",
];
const DEFAULT_LOCATE_CONFIG = {
  instances: DEFAULT_LOCATE_INSTANCES,
  maxProbeCandidates: 5,
  probeConcurrency: 2,
  probeTimeoutMs: 5000,
};

let locateConfigPromise;

async function loadLocateConfig() {
  if (!locateConfigPromise) {
    locateConfigPromise = (async () => {
      let fromFile = {};
      try {
        fromFile = JSON.parse(await readFile(LOCATE_CONFIG_PATH, "utf8"));
      } catch {
        fromFile = {};
      }
      const envList = (process.env.MATRIX_LOCATE_INSTANCES || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const config = { ...DEFAULT_LOCATE_CONFIG, ...fromFile };
      const profile = await getProfile(PROFILE_ID);
      config.instances = envList.length
        ? envList
        : Array.isArray(profile.locateInstances)
          ? profile.locateInstances
          : [];
      return config;
    })();
  }
  return locateConfigPromise;
}

function normalizeInstanceName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s+/g, "");
}

async function makeClient(args) {
  let profile = await getProfile(PROFILE_ID);
  if (args.hospital) {
    const { profiles } = await readSettings();
    const needle = normalize(args.hospital);
    const matches = Object.entries(profiles).filter(([id, candidate]) => [id, candidate.name, candidate.hospital].some((value) => normalize(value) === needle));
    if (!matches.length) throw new MatrixQueryError("Hospital not configured: " + args.hospital, { code: "HOSPITAL_NOT_FOUND" });
    if (matches.length > 1) throw new MatrixQueryError("Hospital matches multiple profiles: " + args.hospital, { code: "HOSPITAL_AMBIGUOUS", candidates: matches.map(([id, candidate]) => ({ id, name: candidate.name, hospital: candidate.hospital, baseUrl: candidate.baseUrl })) });
    profile = { id: matches[0][0], ...matches[0][1] };
  }
  args.envCode ||= profile.envCode;
  args.clusterProperty ||= profile.clusterProperty || DEFAULT_CLUSTER_PROPERTY;
  const username = args.username || profile.credentials?.username;
  const password = args.password || profile.credentials?.password;
  return createAuthenticatedClient({ username, password, baseUrl: profile.baseUrl, proxy: profile.proxy });
}

function getDbCode(database) {
  return typeof database === "string" ? database : database?.dbCode || "";
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function rankMatch(value, keyword) {
  const text = normalize(value);
  const needle = normalize(keyword);
  if (!needle) return 0;
  if (text === needle) return 100;
  if (text.endsWith(`_${needle}`)) return 90;
  if (text.startsWith(needle)) return 80;
  if (text.includes(needle)) return 60;
  return -1;
}

function toolResult(structuredContent, summary) {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(structuredContent, null, 2) },
    ],
    structuredContent,
  };
}

function serializeError(error) {
  const serialized = {
    code: error?.code || "INTERNAL_ERROR",
    message: error?.message || String(error),
  };
  if (error?.target) {
    serialized.target = error.target;
  }
  if (error?.hint) {
    serialized.hint = error.hint;
  }
  if (error?.candidates) {
    serialized.candidates = error.candidates;
  }
  return { error: serialized };
}

function errorResult(error) {
  return {
    content: [{ type: "text", text: JSON.stringify(serializeError(error), null, 2) }],
    isError: true,
  };
}

async function mapWithConcurrency(items, mapper, concurrency = SEARCH_CONCURRENCY) {
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

async function listInstancesForSearch(client, args) {
  const visibleInstances = await listCachedInstances(client, {
    envCode: args.envCode,
    clusterProperty: args.clusterProperty,
    refresh: args.refresh,
  });

  if (args.instanceId) {
    const instanceName = args.instanceName || String(args.instanceId);
    return {
      instances: [{ InstanceId: args.instanceId, InstanceName: instanceName }],
      coverage: {
        source: "explicit",
        searched: [instanceName],
        missing: [],
        totalVisible: visibleInstances.length,
        truncated: false,
      },
    };
  }

  const config = await loadLocateConfig();
  const requested = args.instanceName ? [args.instanceName] : args.instanceNames?.length
    ? args.instanceNames
    : config.instances.length
      ? config.instances
      : visibleInstances.map((instance) => instance.InstanceName || instance.name || String(instance.InstanceId || instance.id));
  const byName = new Map();
  for (const instance of visibleInstances) {
    byName.set(
      normalizeInstanceName(instance.InstanceName || instance.name),
      instance
    );
  }

  const selected = [];
  const missing = [];
  const seen = new Set();
  for (const name of requested) {
    const instance = byName.get(normalizeInstanceName(name));
    if (!instance) {
      missing.push(name);
      continue;
    }
    const instanceId = instance.InstanceId || instance.id;
    if (seen.has(String(instanceId))) {
      continue;
    }
    seen.add(String(instanceId));
    selected.push(instance);
  }

  const limited = args.maxInstances ? selected.slice(0, args.maxInstances) : selected;
  return {
    instances: limited,
    coverage: {
      source: "allowlist",
      configured: requested,
      searched: limited.map(
        (instance) => instance.InstanceName || instance.name || String(instance.InstanceId || instance.id)
      ),
      missing,
      totalVisible: visibleInstances.length,
      truncated: limited.length < selected.length,
    },
  };
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/#[^\n\r]*/g, " ");
}

function validateReadOnlySql(sql) {
  const cleaned = stripSqlComments(sql).trim();
  if (!cleaned) {
    throw new Error("SQL is empty.");
  }
  const withoutTrailingSemicolon = cleaned.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error("Only a single SQL statement is allowed.");
  }
  if (!/^(select|show|explain|desc|describe)\b/i.test(withoutTrailingSemicolon)) {
    throw new Error("Only read-only SQL is allowed: SELECT, SHOW, EXPLAIN, DESC, or DESCRIBE.");
  }
  const forbidden = /\b(insert|update|delete|replace|merge|drop|truncate|alter|create|rename|grant|revoke|call|exec|execute|load|outfile|dumpfile|lock|unlock|set)\b/i;
  if (forbidden.test(withoutTrailingSemicolon)) {
    throw new Error("SQL contains a blocked keyword. Only read-only queries are supported.");
  }
  return withoutTrailingSemicolon;
}

function applySelectLimit(sql, limit) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || DEFAULT_QUERY_LIMIT, 1),
    MAX_QUERY_LIMIT
  );
  if (!/^select\b/i.test(sql)) {
    return sql;
  }
  if (/\blimit\s+\d+(\s*,\s*\d+)?\s*$/i.test(sql)) {
    return sql;
  }
  return `${sql} LIMIT ${safeLimit}`;
}

async function buildTableSearchScopes(client, args, refresh, instances) {
  if (args.dbCode) {
    return instances.map((instance) => ({
      instanceId: instance.InstanceId || instance.id,
      instanceName: instance.InstanceName || instance.name || String(instance.InstanceId || instance.id),
      dbCode: args.dbCode,
      refresh,
    }));
  }

  const seen = new Set();
  const scopes = (await mapWithConcurrency(instances, async (instance) => {
    const instanceId = instance.InstanceId || instance.id;
    const instanceName = instance.InstanceName || instance.name || String(instanceId);
    const databases = await listCachedDatabases(client, {
      instanceId,
      refresh,
    });
    return databases.flatMap((database) => {
      const dbCode = getDbCode(database);
      if (!dbCode) {
        return [];
      }
      return [{
        instanceId,
        instanceName,
        dbCode,
        refresh,
      }];
    });
  })).flat().filter((match) => {
    const dedupeKey = `${match.instanceId}::${match.dbCode}`;
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });

  scopes.sort((left, right) => left.dbCode.localeCompare(right.dbCode));
  return scopes;
}

async function searchTablesInScopes(client, args, scopes, refresh) {
  const keyword = normalize(args.keyword);
  const results = (await mapWithConcurrency(scopes, async (scope) => {
    const tables = await listCachedTables(client, scope.instanceId, scope.dbCode, {
      refresh,
    });
    return tables.flatMap((tableCode) => {
      const score = rankMatch(tableCode, keyword);
      if (score < 0) {
        return [];
      }
      return [{
        instanceId: scope.instanceId,
        instanceName: scope.instanceName,
        dbCode: scope.dbCode,
        tableCode,
        score,
      }];
    });
  })).flat();
  results.sort(
    (left, right) =>
      right.score - left.score ||
      left.dbCode.localeCompare(right.dbCode) ||
      left.tableCode.localeCompare(right.tableCode)
  );
  return results.slice(0, args.limit).map(({ score, ...rest }) => rest);
}

function extractTableName(sql) {
  const match = String(sql || "").match(/\bfrom\s+([A-Za-z0-9_$.`"[\]`]+)/i);
  if (!match) {
    return "";
  }
  return match[1].replace(/[`"\[\]]/g, "").split(".").pop();
}

async function probeTableAccess(client, args, candidate, config) {
  const tableCode = String(candidate.tableCode || "");
  const sql = `SELECT 1 FROM \`${tableCode.replace(/`/g, "``")}\` LIMIT 1`;
  const controller = new AbortController();
  let timer;
  try {
    await Promise.race([
      client.queryRows({
        envCode: args.envCode,
        instanceId: candidate.instanceId,
        dbCode: candidate.dbCode,
        sqlContent: sql,
        tableCode,
        signal: controller.signal,
      }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new MatrixQueryError(`probe timeout after ${config.probeTimeoutMs}ms`, {
              code: "PROBE_TIMEOUT",
              target: {
                instanceId: candidate.instanceId,
                dbCode: candidate.dbCode,
                tableCode,
              },
            })
          );
        }, config.probeTimeoutMs);
      }),
    ]);
    return { ...candidate, accessible: true };
  } catch (error) {
    return {
      ...candidate,
      accessible: false,
      probeError: {
        code: error?.code || "PROBE_FAILED",
        message: error?.message || String(error),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function annotateAccessibility(client, args, candidates, options = {}) {
  const config = await loadLocateConfig();
  const cap = Math.min(candidates.length, options.maxProbes ?? config.maxProbeCandidates);
  if (!cap) {
    return [];
  }
  const probed = await mapWithConcurrency(
    candidates.slice(0, cap),
    (candidate) => probeTableAccess(client, args, candidate, config),
    config.probeConcurrency
  );
  return [
    ...probed,
    ...candidates.slice(cap).map((candidate) => ({ ...candidate, accessible: null })),
  ];
}

const server = new McpServer({
  name: `matrix-query-${PROFILE_ID}`,
  version: "0.1.0",
});

const registerSafeTool = (name, definition, handler) =>
  server.registerTool(name.replace(/^zy_/, `${TOOL_PREFIX}_`), {
    ...definition,
  }, async (args, extra) => {
    try {
      const profile = await getProfile(PROFILE_ID);
      args.envCode ||= profile.envCode;
      args.clusterProperty ||= profile.clusterProperty || DEFAULT_CLUSTER_PROPERTY;
      return await handler(args, extra);
    } catch (error) {
      return errorResult(error);
    }
  });

registerSafeTool(
  "zy_matrix_envs",
  {
    description: "List Matrix data-query environments available to the current account.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      refresh: z.boolean().default(false),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    const envs = await listCachedEnvironments(client, { refresh: args.refresh });
    return toolResult({ envs }, `Found ${envs.length} environments.`);
  }
);

registerSafeTool(
  "zy_matrix_instances",
  {
    description: "List Matrix instances for an environment and cluster type.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      envCode: z.string().optional(),
      clusterProperty: z.string().optional(),
      refresh: z.boolean().default(false),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    const instances = await listCachedInstances(client, {
      envCode: args.envCode,
      clusterProperty: args.clusterProperty,
      refresh: args.refresh,
    });
    return toolResult({ instances }, `Found ${instances.length} instances.`);
  }
);

registerSafeTool(
  "zy_matrix_databases",
  {
    description: "List databases for a Matrix instance.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      instanceId: z.number().int().optional(),
      instanceName: z.string().optional(),
      envCode: z.string().optional(),
      refresh: z.boolean().default(false),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    const target = await resolveInstanceTarget(client, {
      instanceId: args.instanceId,
      instanceName: args.instanceName,
      envCode: args.envCode,
      dbCode: args.dbCode,
    });
    const databases = await listCachedDatabases(client, {
      instanceId: target.instanceId,
      refresh: args.refresh,
    });
    return toolResult({ databases }, `Found ${databases.length} databases.`);
  }
);

registerSafeTool(
  "zy_matrix_tables",
  {
    description: "List tables in a Matrix database.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      instanceId: z.number().int().optional(),
      instanceName: z.string().optional(),
      envCode: z.string().optional(),
      dbCode: z.string(),
      refresh: z.boolean().default(false),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    const target = await resolveInstanceTarget(client, {
      instanceId: args.instanceId,
      instanceName: args.instanceName,
      envCode: args.envCode,
      dbCode: args.dbCode,
    });
    const dbCode = await resolveDatabaseCode({ dbCode: args.dbCode });
    const tables = await listCachedTables(client, target.instanceId, dbCode, {
      refresh: args.refresh,
    });
    return toolResult({ tables }, `Found ${tables.length} tables.`);
  }
);

registerSafeTool(
  "zy_matrix_fields",
  {
    description: "List columns and metadata for a Matrix table.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      instanceId: z.number().int().optional(),
      instanceName: z.string().optional(),
      envCode: z.string().optional(),
      dbCode: z.string(),
      tableCode: z.string(),
      refresh: z.boolean().default(false),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    const target = await resolveInstanceTarget(client, {
      instanceId: args.instanceId,
      instanceName: args.instanceName,
      envCode: args.envCode,
      dbCode: args.dbCode,
    });
    const dbCode = await resolveDatabaseCode({ dbCode: args.dbCode });
    const fields = await listCachedFields(
      client,
      target.instanceId,
      dbCode,
      args.tableCode,
      { refresh: args.refresh }
    );
    return toolResult({ fields }, `Found ${fields.length} fields.`);
  }
);

registerSafeTool(
  "zy_matrix_find_databases",
  {
    description: "Search databases across Matrix instances by exact, suffix, prefix, or contains match.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      keyword: z.string(),
      envCode: z.string().optional(),
      clusterProperty: z.string().optional(),
      instanceId: z.number().int().optional(),
      instanceName: z.string().optional(),
      instanceNames: z.array(z.string()).optional(),
      maxInstances: z.number().int().min(1).max(50).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      refresh: z.boolean().default(false),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    const { instances, coverage } = await listInstancesForSearch(client, args);
    const matches = (await mapWithConcurrency(instances, async (instance) => {
      const instanceId = instance.InstanceId || instance.id;
      const databases = await listCachedDatabases(client, {
        instanceId,
        refresh: args.refresh,
      });
      return databases.flatMap((database) => {
        const dbCode = getDbCode(database);
        const score = rankMatch(dbCode, args.keyword);
        if (score >= 0) {
          return [{
            instanceId,
            instanceName: instance.InstanceName || instance.name || String(instanceId),
            dbCode,
            score,
          }];
        }
        return [];
      });
    })).flat();

    matches.sort((left, right) => right.score - left.score || left.dbCode.localeCompare(right.dbCode));
    const results = matches.slice(0, args.limit).map(({ score, ...rest }) => rest);
    return toolResult(
      { matches: results, coverage },
      `Found ${results.length} database matches across ${coverage.searched.length} instances.`
    );
  }
);

registerSafeTool(
  "zy_matrix_find_tables",
  {
    description:
      "Search tables in the configured instance allowlist (or one database when dbCode is given). Returns a coverage block so truncated searches are visible.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      keyword: z.string(),
      envCode: z.string().optional(),
      clusterProperty: z.string().optional(),
      instanceId: z.number().int().optional(),
      instanceName: z.string().optional(),
      instanceNames: z.array(z.string()).optional(),
      dbCode: z.string().optional(),
      maxInstances: z.number().int().min(1).max(50).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      refresh: z.boolean().default(false),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    if (!args.dbCode && !args.refresh) {
      const cachedMatches = await findCachedTables(client, args.keyword, {
        limit: args.limit,
        instanceId: args.instanceId,
        instanceName: args.instanceName,
      });
      if (cachedMatches.length) {
        return toolResult(
          {
            matches: cachedMatches,
            coverage: { source: "cache", truncated: false, mayBePartial: true },
          },
          `Found ${cachedMatches.length} cached table matches.`
        );
      }
    }

    const { instances, coverage } = await listInstancesForSearch(client, args);
    const scopes = await buildTableSearchScopes(client, args, args.refresh, instances);
    const results = await searchTablesInScopes(client, args, scopes, args.refresh);
    return toolResult(
      { matches: results, coverage: { ...coverage, source: "scan" } },
      `Found ${results.length} table matches across ${coverage.searched.length} instances.`
    );
  }
);

registerSafeTool(
  "zy_matrix_locate_table",
  {
    description:
      "Locate a table across configured instances and report whether the current account can query each candidate.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      keyword: z.string(),
      envCode: z.string().optional(),
      clusterProperty: z.string().optional(),
      instanceId: z.number().int().optional(),
      instanceName: z.string().optional(),
      instanceNames: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      probe: z.boolean().default(true),
      maxProbes: z.number().int().min(1).max(10).optional(),
      refresh: z.boolean().default(false),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    const { instances, coverage } = await listInstancesForSearch(client, args);
    const scopes = await buildTableSearchScopes(client, args, args.refresh, instances);
    const matches = await searchTablesInScopes(client, args, scopes, args.refresh);
    const candidates = matches.slice(0, args.limit);
    const annotated = args.probe
      ? await annotateAccessibility(client, args, candidates, { maxProbes: args.maxProbes })
      : candidates.map((candidate) => ({ ...candidate, accessible: null }));
    const accessible = annotated.filter((candidate) => candidate.accessible === true);
    const unprobed = annotated.filter((candidate) => candidate.accessible === null);
    return toolResult(
      {
        matches: annotated,
        coverage: { ...coverage, source: "scan" },
        summary: {
          candidates: annotated.length,
          accessible: accessible.length,
          inaccessible: annotated.filter((candidate) => candidate.accessible === false).length,
          unprobed: unprobed.length,
        },
      },
      `Located ${annotated.length} candidates, ${accessible.length} accessible.`
    );
  }
);

registerSafeTool(
  "zy_matrix_describe_table",
  {
    description: "Describe a Matrix table with field metadata and an optional small sample of rows.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      instanceId: z.number().int().optional(),
      instanceName: z.string().optional(),
      envCode: z.string().optional(),
      dbCode: z.string(),
      tableCode: z.string(),
      sampleRows: z.number().int().min(0).max(20).default(0),
      refresh: z.boolean().default(false),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    const target = await resolveInstanceTarget(client, {
      instanceId: args.instanceId,
      instanceName: args.instanceName,
      envCode: args.envCode,
      dbCode: args.dbCode,
    });
    const dbCode = await resolveDatabaseCode({ dbCode: args.dbCode });
    const fields = await listCachedFields(
      client,
      target.instanceId,
      dbCode,
      args.tableCode,
      { refresh: args.refresh }
    );
    let sampleRows = [];
    if (args.sampleRows > 0) {
      const quotedTable = `\`${String(args.tableCode).replace(/`/g, "``")}\``;
      const sql = applySelectLimit(`SELECT * FROM ${quotedTable}`, args.sampleRows);
      sampleRows = await client.queryRows({
        envCode: args.envCode,
        instanceId: target.instanceId,
        dbCode,
        sqlContent: sql,
      });
    }
    const result = {
      instanceId: target.instanceId,
      instanceName: target.instanceName,
      dbCode,
      tableCode: args.tableCode,
      fields,
      sampleRows,
    };
    if (!fields.length) {
      result.diagnostics = {
        code: "EMPTY_FIELDS",
        message: "Matrix returned no fields for this table in the resolved instance/db.",
        hint: "该表可能不在此实例/库；可调用 locate_table 确认可查询位置。",
      };
    }
    return toolResult(result, `Found ${fields.length} fields and ${sampleRows.length} sample rows.`);
  }
);

registerSafeTool(
  "zy_matrix_query",
  {
    description:
      "Run a read-only SQL query through Matrix data-query and return parsed rows. When dbCode is omitted, the target is resolved from the metadata cache and probed for access; ambiguous targets return candidates instead of guessing.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      envCode: z.string().optional(),
      hospital: z.string().optional(),
      instanceId: z.number().int().optional(),
      instanceName: z.string().optional(),
      dbCode: z.string().optional(),
      tableCode: z.string().optional(),
      sql: z.string(),
      limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).default(DEFAULT_QUERY_LIMIT),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    const sql = applySelectLimit(validateReadOnlySql(args.sql), args.limit);
    let dbCode = args.dbCode ? await resolveDatabaseCode({ dbCode: args.dbCode }) : "";
    let instanceId = args.instanceId;
    let instanceName = args.instanceName;
    let autoResolved = null;

    if (!dbCode) {
      const tableName = args.tableCode || extractTableName(sql);
      if (!tableName) {
        throw new MatrixQueryError(
          "dbCode is required when the SQL has no FROM <table> clause.",
          {
            code: "MISSING_DB_CODE",
            hint: "传入 dbCode，或在 SQL 中写 FROM <table>，或先调用 locate_table。",
          }
        );
      }
      const cached = await findCachedTables(client, tableName, { limit: 1000, instanceId: args.instanceId, instanceName: args.instanceName });
      const exact = cached.filter(
        (candidate) => normalize(candidate.tableCode) === normalize(tableName)
      );
      if (exact.length > 5) {
        throw new MatrixQueryError(
          `Table "${tableName}" has more than five cached locations; pass dbCode and instanceId explicitly.`,
          {
            code: "TOO_MANY_CANDIDATES",
            hint: "候选位置过多，未自动探测或选择；先调用 locate_table，再明确指定目标。",
            candidates: exact.slice(0, 20),
          }
        );
      }
      const annotated = await annotateAccessibility(client, args, exact);
      const accessible = annotated.filter((candidate) => candidate.accessible === true);
      if (accessible.length === 1) {
        dbCode = accessible[0].dbCode;
        instanceId = accessible[0].instanceId;
        instanceName = accessible[0].instanceName;
        autoResolved = { ...accessible[0], source: "cache" };
      } else if (accessible.length > 1) {
        throw new MatrixQueryError(
          `Table "${tableName}" exists in ${accessible.length} accessible locations; pass dbCode explicitly.`,
          {
            code: "AMBIGUOUS_TARGET",
            hint: "从 candidates 中选择 dbCode（必要时同时传 instanceId）后重试。",
            candidates: accessible,
          }
        );
      } else if (exact.length) {
        throw new MatrixQueryError(
          `Table "${tableName}" was found in metadata but no location is accessible to this account.`,
          { code: "NO_ACCESSIBLE_TARGET", candidates: exact }
        );
      } else {
        throw new MatrixQueryError(
          `Table "${tableName}" is not in the metadata cache; run locate_table first or pass dbCode.`,
          {
            code: "TABLE_NOT_LOCATED",
            hint: "先调用 locate_table(keyword) 定位，再重试查询。",
          }
        );
      }
    }

    const target = await resolveInstanceTarget(client, {
      instanceId,
      instanceName,
      envCode: args.envCode,
      dbCode,
    });
    const rows = await client.queryRows({
      envCode: args.envCode,
      instanceId: target.instanceId,
      dbCode,
      sqlContent: sql,
      tableCode: args.tableCode || autoResolved?.tableCode,
    });
    return toolResult(
      {
        rows,
        target: {
          instanceId: target.instanceId,
          instanceName: target.instanceName,
          dbCode,
          tableCode: args.tableCode || autoResolved?.tableCode || null,
        },
        autoResolved,
      },
      `Returned ${rows.length} rows from ${dbCode}.`
    );
  }
);

registerSafeTool(
  "zy_matrix_warm_metadata_cache",
  {
    description: "Preload Matrix metadata into the local file cache so later sessions can read metadata from disk.",
    inputSchema: {
      username: z.string().optional(),
      password: z.string().optional(),
      envCode: z.string().optional(),
      clusterProperty: z.string().optional(),
      instancePatterns: z.array(z.string()).optional(),
      includeTables: z.boolean().default(true),
      includeFields: z.boolean().default(false),
      maxInstances: z.number().int().min(1).max(100).optional(),
      maxDatabases: z.number().int().min(1).max(500).optional(),
      maxTables: z.number().int().min(1).max(2000).optional(),
      refresh: z.boolean().default(false),
    },
  },
  async (args) => {
    const client = await makeClient(args);
    const summary = await warmMetadataCache(client, {
      envCode: args.envCode,
      clusterProperty: args.clusterProperty,
      instancePatterns: args.instancePatterns || (await getProfile(PROFILE_ID)).locateInstances,
      includeTables: args.includeTables,
      includeFields: args.includeFields,
      maxInstances: args.maxInstances,
      maxDatabases: args.maxDatabases,
      maxTables: args.maxTables,
      refresh: args.refresh,
    });
    return toolResult(summary, `Warmed ${summary.tables} tables and ${summary.fields} fields.`);
  }
);

registerSafeTool(
  "zy_matrix_clear_metadata_cache",
  {
    description: "Clear the local Matrix metadata cache for environments, instances, databases, tables, and fields.",
    inputSchema: {},
  },
  async () => {
    await clearMetadataCache();
    const result = { ok: true };
    return toolResult(result, "Metadata cache cleared.");
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
