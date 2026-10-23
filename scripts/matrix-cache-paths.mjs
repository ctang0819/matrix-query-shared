import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const PLUGIN_CACHE_ROOT = path.dirname(ROOT_DIR);

export const CACHE_DIR =
  process.env.MATRIX_CACHE_DIR || path.join(homedir(), ".codex", "matrix-query", "cache");
export const METADATA_CACHE_PATH = path.join(CACHE_DIR, "matrix-metadata-cache.json");
export const SESSION_CACHE_PATH = path.join(CACHE_DIR, "matrix-session-cache.json");

export async function findLegacyCacheFiles(fileName) {
  if (process.env.MATRIX_CACHE_DIR) {
    return [];
  }
  try {
    const versions = await readdir(PLUGIN_CACHE_ROOT, { withFileTypes: true });
    const candidates = await Promise.all(
      versions
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const filePath = path.join(PLUGIN_CACHE_ROOT, entry.name, ".cache", fileName);
          try {
            const details = await stat(filePath);
            return details.size > 0 ? { filePath, mtimeMs: details.mtimeMs } : null;
          } catch {
            return null;
          }
        })
    );
    return candidates
      .filter(Boolean)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .map(({ filePath }) => filePath);
  } catch {
    return [];
  }
}

export async function findLegacyCacheFile(fileName) {
  return (await findLegacyCacheFiles(fileName))[0] || null;
}
