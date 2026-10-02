import fs from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const unavailable = () => new Error("MCP credential authority unavailable");
const own = (value, keys) => plain(value) && keys.every((key) => Object.hasOwn(value, key));
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const MAX_BYTES = 2_097_152;
function synchronous(value) {
  if (value && typeof value.then === "function") { Promise.resolve(value).catch(() => undefined); throw unavailable(); }
  return value;
}
function endpoint(value) {
  if (typeof value !== "string" || /[\x00-\x20\x7f]/.test(value)) throw unavailable();
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw unavailable();
  return url.href;
}
function revision(path, missingAllowed) {
  let fd;
  try {
    let before;
    try { before = fs.lstatSync(path); }
    catch (error) { if (missingAllowed && error.code === "ENOENT") return null; throw error; }
    const regular = (stat) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_BYTES;
    if (!regular(before)) throw unavailable();
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!regular(opened) || opened.ino !== before.ino || opened.dev !== before.dev) throw unavailable();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0, read;
    while (size < bytes.length && (read = fs.readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += read;
    const after = fs.fstatSync(fd), current = fs.lstatSync(path);
    if (size > MAX_BYTES || size !== after.size || !regular(after) || !regular(current)
      || ["ino", "dev", "size", "mtimeMs", "ctimeMs"].some((key) => opened[key] !== after[key] || after[key] !== current[key])) throw unavailable();
    return createHash("sha256").update(bytes.subarray(0, size)).digest("hex");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * INTERNAL authority for OAuth credential storage, NOT MCP tool/connection permission.
 * Consumes a successful pure snapshot from prepareBackendMcpConfigLoader; construction
 * invokes only that captured callback, no filesystem/runtime/credential service calls.
 * Allows configured HTTP identities, including disabled entries for auth management,
 * but never stdio, Authorization headers or provider-managed auth. No secret evaluation.
 * Every assertion checks the explicit runtime lease before/after fresh fixed-file hashes.
 * Observed lease/revision/read failures permanently fence this instance; rejected caller
 * identities do NOT revoke it. Reprepare a snapshot/new gate after any observed failure.
 * No writes, locks, project/cwd/env lookup, credential IO, migration or session activation.
 * This is NOT a writer barrier/CAS/sandbox: hashes cannot detect unobserved ABA restores
 * or exclude noncooperating writers/ancestor/TOCTOU races. The supplied runtime lease
 * must attest the process-owned monotonic generation; activation/writers remain separate.
 * Source files must be regular, single-link, <=2MiB. No paths/hashes/causes leave errors.
 */
export function createBackendMcpCredentialAuthority(options) {
  try {
    const keys = ["agentDir", "bundledConfigPath", "prepared", "assertRuntimeOwner"];
    if (!own(options, keys) || Object.keys(options).some((key) => !keys.includes(key))) throw unavailable();
    const captured = Object.fromEntries(keys.map((key) => [key, options[key]]));
    if (typeof captured.agentDir !== "string" || !isAbsolute(captured.agentDir)
      || typeof captured.bundledConfigPath !== "string" || !isAbsolute(captured.bundledConfigPath)
      || typeof captured.assertRuntimeOwner !== "function") throw unavailable();
    const agentDir = resolve(captured.agentDir), configPath = join(agentDir, "mcp.json"), bundledPath = resolve(captured.bundledConfigPath);
    const comparePath = (path) => process.platform === "win32" ? path.toLowerCase() : path;
    if (comparePath(configPath) === comparePath(bundledPath)) throw unavailable();
    const preparedKeys = ["ok", "issues", "sourceSha256", "bundledSha256", "serverCount", "loadConfig"];
    if (!own(captured.prepared, preparedKeys)) throw unavailable();
    const prepared = Object.fromEntries(preparedKeys.map((key) => [key, captured.prepared[key]]));
    if (prepared.ok !== true || !Array.isArray(prepared.issues) || prepared.issues.length !== 0
      || (prepared.sourceSha256 !== null && !digest(prepared.sourceSha256)) || !digest(prepared.bundledSha256)
      || !Number.isSafeInteger(prepared.serverCount) || prepared.serverCount < 0 || typeof prepared.loadConfig !== "function") throw unavailable();
    const snapshot = structuredClone(synchronous(prepared.loadConfig()));
    if (!own(snapshot, ["servers", "errors"]) || !Array.isArray(snapshot.servers) || snapshot.servers.length !== prepared.serverCount
      || !Array.isArray(snapshot.errors) || snapshot.errors.length !== 0) throw unavailable();
    const seen = new Set(), allowed = new Map();
    for (const entry of snapshot.servers) {
      if (!own(entry, ["name", "config", "source", "scope"]) || typeof entry.name !== "string"
        || !/^[A-Za-z0-9_-]+$/.test(entry.name) || !plain(entry.config) || entry.source !== configPath || entry.scope !== "global") throw unavailable();
      const namespace = `mcp__${entry.name.replaceAll("-", "_")}`;
      if (seen.has(namespace)) throw unavailable();
      seen.add(namespace);
      const config = entry.config;
      if (!Object.hasOwn(config, "url")) continue;
      if (Object.hasOwn(config, "command")) throw unavailable();
      const url = endpoint(config.url);
      if (config.headers !== undefined && (!plain(config.headers))) throw unavailable();
      if (Object.hasOwn(config, "auth") && config.auth !== undefined) continue;
      if (config.headers && Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization")) continue;
      allowed.set(namespace, url);
    }
    let fenced = false;
    return (value) => {
      try {
        if (!own(value, ["namespace", "serverUrl"]) || Object.keys(value).some((key) => !["namespace", "serverUrl"].includes(key))) throw unavailable();
        const id = Object.freeze({ namespace: value.namespace, serverUrl: value.serverUrl });
        if (typeof id.namespace !== "string" || !/^mcp__[A-Za-z0-9_]+$/.test(id.namespace)
          || endpoint(id.serverUrl) !== id.serverUrl || allowed.get(id.namespace) !== id.serverUrl || fenced) throw unavailable();
        try {
          if (synchronous(captured.assertRuntimeOwner()) !== undefined || fenced) throw unavailable();
          const directory = fs.lstatSync(agentDir);
          if (!directory.isDirectory() || directory.isSymbolicLink()) throw unavailable();
          if (revision(configPath, true) !== prepared.sourceSha256 || revision(bundledPath, false) !== prepared.bundledSha256) throw unavailable();
          if (fenced || synchronous(captured.assertRuntimeOwner()) !== undefined || fenced) throw unavailable();
        } catch { fenced = true; throw unavailable(); }
      } catch { throw unavailable(); }
    };
  } catch { throw unavailable(); }
}
