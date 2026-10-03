import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { planMcpConfigMigration } from "./mcp-config-migration.mjs";
const plain = (v) => v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, keys) => plain(v) && keys.every((k) => Object.hasOwn(v, k));
const only = (v, keys) => Reflect.ownKeys(v).every((k) => keys.includes(k));
const unavailable = () => new Error("MCP configuration file unavailable");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const MAX_BYTES = 2_097_152;
function ack(v) {
  if (v && typeof v.then === "function") Promise.resolve(v).catch(() => undefined);
  if (v !== undefined) throw unavailable();
}
const regular = (s) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= MAX_BYTES;
const same = (a, b) => ["ino", "dev", "size", "mtimeMs", "ctimeMs", "uid", "gid", "mode"].every((k) => a[k] === b[k]);
function readSource(path, privateFile) {
  const before = fs.lstatSync(path);
  if (!regular(before) || (privateFile && process.platform !== "win32" && (before.mode & 0o7777) !== 0o600)) throw unavailable();
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!regular(opened) || !same(before, opened)) throw unavailable();
    const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    const after = fs.fstatSync(fd), current = fs.lstatSync(path);
    if (size > MAX_BYTES || size !== after.size || !same(opened, after) || !same(after, current) || !regular(current)) throw unavailable();
    const bytes = buffer.subarray(0, size);
    return { bytes, hash: sha(bytes), stat: current };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function document(bytes) {
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "", text = decoded.slice(bom.length);
  if (/\r(?!\n)/.test(text) || (/\r\n/.test(text) && /(?<!\r)\n/.test(text))) throw unavailable();
  const values = JSON.parse(text);
  if (!own(values, ["mcpServers"]) || !plain(values.mcpServers)) throw unavailable();
  const finite = (v) => { if (typeof v === "number" && !Number.isFinite(v)) throw unavailable(); if (v && typeof v === "object") Object.values(v).forEach(finite); };
  finite(values);
  // Refuse legacy conversion/unsupported server fields. Full SDK preflight belongs to the
  // prepared snapshot whose exact hashes the caller supplies; no reference evaluation here.
  const subset = { mcpServers: values.mcpServers, ...(Object.hasOwn(values, "autoEnableCodemode") ? { autoEnableCodemode: values.autoEnableCodemode } : {}) };
  const plan = planMcpConfigMigration(subset);
  if (!plan.ok || !isDeepStrictEqual(plan.config, subset)) throw unavailable();
  return { values, bom, newline: text.includes("\r\n") ? "\r\n" : "\n", indent: text.match(/^[\t ]+(?=")/m)?.[0] ?? "  ", ending: text.endsWith("\n") ? "\n" : "" };
}
function ownedPath(path, stat) {
  const current = fs.lstatSync(path);
  if (!regular(current) || current.ino !== stat.ino || current.dev !== stat.dev) throw unavailable();
}

/** INTERNAL synchronous fixed-file settings/auth writer; constructor performs no IO/callbacks.
 * Existing native user file/server only. Two request kinds, exactly one per call: a settings patch
 * (`enabled`/`exposure`) or bounded `headers` entries (value null removes; names are matched
 * case-insensitively). No creation/import/migration, ACL/mode changes,
 * SDK default writer, reference execution, credentials, session reload or publication.
 * Mandatory fresh private-storage attestor must approve existing file and directory child
 * inheritance/local filesystem. Linux additionally enforces 0700 directory/0600 file.
 * The private updater provides SDK-prevalidated snapshot hashes and a live writer scope.
 * Cooperating instances use exclusive mcp.json.native-write.lock, NO automatic stale reclaim
 * or supported manual deletion. Existing adapter/migration/SDK writers must be quiesced.
 * Bounded single-link regular-file reads, both revisions + directory identity rechecked,
 * exclusive 0600 temp, fsync, atomic rename. No filesystem CAS/sandbox against uncooperative
 * writers/ancestor/TOCTOU races; no directory power-loss durability or rollback claim.
 * A post-rename cleanup failure is partial: throws without pretending old bytes were restored.
 */
export function createBackendMcpConfigFileWriter(options) {
  try {
    const keys = ["agentDir", "bundledConfigPath", "assertPrivateStorage"];
    if (!own(options, keys) || !only(options, keys)) throw unavailable();
    const captured = Object.fromEntries(keys.map((k) => [k, options[k]]));
    if (typeof captured.agentDir !== "string" || !isAbsolute(captured.agentDir)
      || typeof captured.bundledConfigPath !== "string" || !isAbsolute(captured.bundledConfigPath)
      || typeof captured.assertPrivateStorage !== "function") throw unavailable();
    const agentDir = resolve(captured.agentDir), configPath = join(agentDir, "mcp.json"), bundledConfigPath = resolve(captured.bundledConfigPath);
    const comparable = (p) => process.platform === "win32" ? p.toLowerCase() : p;
    if (comparable(configPath) === comparable(bundledConfigPath)) throw unavailable();
    const location = Object.freeze({ agentDir, configPath }), lockPath = `${configPath}.native-write.lock`;
    return (input, inputScope) => {
      let lockFd, lockStat, tempFd, tempStat, tempPath;
      try {
        const requestKeys = ["configPath", "bundledConfigPath", "expectedSha256", "expectedBundledSha256", "serverName", "patch", "headers"];
        const requiredKeys = requestKeys.slice(0, 5);
        if (!own(input, requiredKeys) || !only(input, requestKeys) || !own(inputScope, ["assertOwner"])) throw unavailable();
        const r = Object.fromEntries(requiredKeys.map((k) => [k, input[k]])), assertOwner = inputScope.assertOwner;
        if (r.configPath !== configPath || r.bundledConfigPath !== bundledConfigPath || !digest(r.expectedSha256)
          || !digest(r.expectedBundledSha256) || typeof r.serverName !== "string" || !/^[A-Za-z0-9_-]+$/.test(r.serverName)
          || typeof assertOwner !== "function") throw unavailable();
        const hasPatch = Object.hasOwn(input, "patch"), hasHeaders = Object.hasOwn(input, "headers");
        if (hasPatch === hasHeaders) throw unavailable(); // exactly one operation per request
        const patch = {};
        if (hasPatch) {
          if (!plain(input.patch) || !only(input.patch, ["enabled", "exposure"])) throw unavailable();
          if (Object.hasOwn(input.patch, "enabled")) { const v = input.patch.enabled; if (typeof v !== "boolean") throw unavailable(); patch.enabled = v; }
          if (Object.hasOwn(input.patch, "exposure")) { const v = input.patch.exposure; if (!["codemode", "deferred", "direct", "hidden"].includes(v)) throw unavailable(); patch.exposure = v; }
          if (!Object.keys(patch).length) throw unavailable();
        }
        // Auth headers: set a value, or null to remove it. Names/values are bounded and shell-free.
        const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
        const headers = hasHeaders ? structuredClone(input.headers) : null;
        if (hasHeaders) {
          if (!plain(headers) || Reflect.ownKeys(headers).length === 0) throw unavailable();
          for (const key of Reflect.ownKeys(headers)) {
            const value = headers[key];
            if (typeof key !== "string" || key.length > 256 || !headerName.test(key)
              || (value !== null && (typeof value !== "string" || value.length > 8192 || /[\0\r\n]/.test(value)))) throw unavailable();
          }
        }
        const guard = () => {
          ack(assertOwner()); ack(captured.assertPrivateStorage(location));
          const d = fs.lstatSync(agentDir);
          if (!d.isDirectory() || d.isSymbolicLink() || (process.platform !== "win32" && (d.mode & 0o7777) !== 0o700)) throw unavailable();
          ack(assertOwner()); return d;
        };
        const directory = guard();
        lockFd = fs.openSync(lockPath, "wx", 0o600); lockStat = fs.fstatSync(lockFd);
        const check = () => {
          const current = guard();
          if (["ino", "dev", "uid", "gid", "mode"].some((k) => current[k] !== directory[k])) throw unavailable();
          ownedPath(lockPath, lockStat);
          const user = readSource(configPath, true), bundled = readSource(bundledConfigPath, false);
          if (user.hash !== r.expectedSha256 || bundled.hash !== r.expectedBundledSha256) throw unavailable();
          ack(assertOwner()); return user;
        };
        const original = check(), doc = document(original.bytes);
        if (!Object.hasOwn(doc.values.mcpServers, r.serverName)) throw unavailable();
        const target = doc.values.mcpServers[r.serverName], before = structuredClone(target);
        if (Object.hasOwn(patch, "enabled")) { if (patch.enabled) delete target.enabled; else target.enabled = false; }
        if (Object.hasOwn(patch, "exposure")) { if (patch.exposure === "codemode") delete target.exposure; else target.exposure = patch.exposure; }
        if (headers) {
          const existing = target.headers;
          if (existing !== undefined && !plain(existing)) throw unavailable();
          const map = existing ?? {};
          for (const [name, value] of Object.entries(headers)) {
            for (const key of Object.keys(map)) if (key.toLowerCase() === name.toLowerCase()) delete map[key];
            if (value !== null) map[name] = value;
          }
          if (Object.keys(map).length === 0) delete target.headers; else target.headers = map;
        }
        if (isDeepStrictEqual(before, target)) { check(); return undefined; }
        const output = Buffer.from(doc.bom + (JSON.stringify(doc.values, null, doc.indent) + doc.ending).replaceAll("\n", doc.newline), "utf8");
        if (output.length > MAX_BYTES) throw unavailable();
        tempPath = join(agentDir, `.mcp-config-${randomUUID()}.tmp`);
        tempFd = fs.openSync(tempPath, "wx", 0o600); tempStat = fs.fstatSync(tempFd);
        fs.writeFileSync(tempFd, output); fs.fsyncSync(tempFd); fs.closeSync(tempFd); tempFd = undefined;
        check(); ownedPath(tempPath, tempStat);
        if (readSource(tempPath, true).hash !== sha(output)) throw unavailable();
        ack(assertOwner());
        fs.renameSync(tempPath, configPath); tempPath = undefined;
      } catch { throw unavailable(); }
      finally {
        try {
          if (tempFd !== undefined) fs.closeSync(tempFd);
          if (tempPath && tempStat) { ownedPath(tempPath, tempStat); fs.unlinkSync(tempPath); }
        } catch { throw unavailable(); }
        finally {
          try {
            if (lockFd !== undefined) fs.closeSync(lockFd);
            if (lockStat) { ownedPath(lockPath, lockStat); fs.unlinkSync(lockPath); }
          } catch { throw unavailable(); }
        }
      }
    };
  } catch { throw unavailable(); }
}
