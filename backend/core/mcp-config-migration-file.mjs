import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { prepareMcpConfigMigration } from "./mcp-config-validation.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failure = (code, extra = {}) => ({ ok: false, applied: false, issues: [{ code }], ...extra });

async function writeExclusive(path, bytes) {
  const file = await open(path, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch {
    await unlink(path); // Only remove the file this exclusive open created.
    throw new Error("Exclusive write failed");
  }
}

/**
 * Internal Backend primitive, NOT an arbitrary-path WebUI endpoint. Dry-run is
 * the default and never writes the source directory. Apply requires a matching
 * dry-run source hash, saves original bytes, then atomically replaces the file.
 * Results contain no config/SDK error values. Backups contain credentials and
 * must remain in the private source directory; permission mode is 0600 on POSIX
 * and inherited directory ACLs govern access on Windows.
 * The sibling lock coordinates only cooperating migration writers. Callers must
 * quiesce OTHER config writers before apply: there is no filesystem CAS against
 * non-cooperating writers between the final hash check and rename. A crash can
 * leave the lock/backup; locks are not automatically broken. No session reload.
 */
export async function migrateMcpConfigFile({
  configPath, bundledConfig, urlVariables, apply = false, expectedSha256,
} = {}) {
  if (typeof configPath !== "string" || !configPath.trim() || typeof apply !== "boolean") {
    return failure("invalid-file-options");
  }
  if (apply && (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256))) {
    return failure("source-hash-required");
  }
  const path = resolve(configPath);
  let source;
  try {
    if (!(await lstat(path)).isFile()) return failure("source-not-regular-file");
    source = await readFile(path);
  } catch {
    return failure("source-unreadable");
  }
  const sourceSha256 = sha256(source);
  if (apply && expectedSha256 !== sourceSha256) return failure("source-changed");
  let text;
  let input;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return failure("invalid-source-encoding");
  }
  try {
    input = JSON.parse(text);
  } catch {
    return failure("invalid-source-json");
  }
  const plan = await prepareMcpConfigMigration(input, bundledConfig, { urlVariables });
  if (!plan.ok) return { ok: false, applied: false, issues: plan.issues };
  const changed = !isDeepStrictEqual(input, plan.config);
  const summary = { ok: true, issues: [], applied: false, changed, sourceSha256,
    serverCount: Object.keys(plan.config.mcpServers).length };
  if (!apply || !changed) return summary;

  const lockPath = `${path}.migration.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    return failure("migration-lock-unavailable");
  }
  let backupPath;
  let tempPath;
  let result;
  let applied = false;
  try {
    if (!(await lstat(path)).isFile() || sha256(await readFile(path)) !== sourceSha256) {
      result = failure("source-changed");
    } else {
      const id = randomUUID();
      const backup = `${path}.migration-${id}.bak`;
      await writeExclusive(backup, source);
      backupPath = backup;
      const newline = text.includes("\r\n") ? "\r\n" : "\n";
      const indent = text.match(/\n([ \t]+)"/)?.[1] ?? "  ";
      const bom = source.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "\uFEFF" : "";
      const suffix = text.endsWith("\n") ? newline : "";
      const output = bom + JSON.stringify(plan.config, null, indent).replace(/\n/g, newline) + suffix;
      const temporary = `${path}.migration-${id}.tmp`;
      await writeExclusive(temporary, Buffer.from(output, "utf8"));
      tempPath = temporary;
      if (!(await lstat(path)).isFile() || sha256(await readFile(path)) !== sourceSha256) {
        result = failure("source-changed", { backupPath });
      } else {
        await rename(tempPath, path);
        tempPath = undefined;
        applied = true;
        result = { ...summary, applied, backupPath, resultSha256: sha256(Buffer.from(output, "utf8")) };
      }
    }
  } catch {
    result = failure("migration-write-failed", { ...(backupPath ? { backupPath } : {}), applied });
  } finally {
    let cleanupFailed = false;
    if (tempPath) {
      try { await unlink(tempPath); } catch { cleanupFailed = true; }
    }
    try { await lock.close(); } catch { cleanupFailed = true; }
    try { await unlink(lockPath); } catch { cleanupFailed = true; }
    if (cleanupFailed) {
      result = failure("migration-cleanup-failed", { applied, ...(backupPath ? { backupPath } : {}) });
    }
  }
  return result;
}
