import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { saveProfiles } from "./profile-store.mjs";

const cacheRoot = path.join(os.homedir(), ".codex", "matrix-query");
const pluginRoot = path.join(os.homedir(), ".codex", "plugins", "cache");
const hnxkRoot = path.join(pluginRoot, "personal", "matrix-query-hnxk", "0.1.0+codex.20260711140328");
const wzRoot = path.join(pluginRoot, "personal", "matrix-query-wz", "0.1.0+codex.20260711140328");
const zyRoot = path.join(pluginRoot, "matrix-local", "matrix-query-zy", "0.1.0+codex.20260711142103");

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readZyEnv() {
  const source = await readFile(path.join(zyRoot, "credentials.env"), "utf8");
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(MATRIX_USERNAME|MATRIX_PASSWORD)\s*=\s*(.*?)\s*$/);
    if (match) result[match[1] === "MATRIX_USERNAME" ? "username" : "password"] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return result;
}

const [hnxk, wz] = await Promise.all([
  json(path.join(hnxkRoot, "config", "hnxk-profile.json")),
  json(path.join(wzRoot, "config", "wz-profile.json")),
]);
const zyCredentials = await readZyEnv();
const profiles = {
  hnxk: {
    name: "HNXK",
    baseUrl: hnxk.baseUrl,
    envCode: hnxk.envCode,
    defaultDbCode: hnxk.defaultDbCode,
    defaultInstanceName: hnxk.defaultInstanceName,
    credentials: hnxk.credentials || {},
    proxy: hnxk.proxy || {},
    cacheDir: path.join(cacheRoot, "hnxk"),
    metadataTtlHours: 0,
    clusterProperty: "mysql",
    aliasesFile: path.join(hnxkRoot, "config", "matrix-aliases.json"),
  },
  wz: {
    name: "WZ",
    baseUrl: wz.baseUrl,
    envCode: wz.envCode,
    defaultDbCode: wz.defaultDbCode,
    defaultInstanceName: wz.defaultInstanceName,
    credentials: wz.credentials || {},
    proxy: wz.proxy || {},
    cacheDir: path.join(cacheRoot, "wz"),
    metadataTtlHours: 0,
    clusterProperty: "mysql",
    aliasesFile: path.join(wzRoot, "config", "matrix-aliases.json"),
  },
  zy: {
    name: "ZY",
    baseUrl: "https://release.zy91.com:4443",
    envCode: "zy-prd",
    defaultDbCode: "oc",
    defaultInstanceId: 8,
    credentials: zyCredentials,
    proxy: {},
    cacheDir: path.join(os.homedir(), ".codex", "matrix-query-zy", "cache"),
    metadataTtlHours: 0,
    clusterProperty: "mysql",
    aliasesFile: null,
    locateInstances: ["余杭生产HIS数据库", "his-drds", "his-adb", "三方-adb", "三方-adb-new(余杭)", "hbos", "bingo", "生产redis"],
  },
};

for (const profile of Object.values(profiles)) {
  if (profile.aliasesFile) {
    try { profile.aliases = await json(profile.aliasesFile); } catch { profile.aliases = {}; }
    delete profile.aliasesFile;
  }
}
await saveProfiles(profiles, { hnxk: "hnxk", wz: "wz", zy: "zy" });
process.stdout.write(`Migrated ${Object.keys(profiles).length} connection profiles.\n`);
