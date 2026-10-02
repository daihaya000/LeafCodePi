import fs from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
const unavailable = () => new Error("MCP configuration revision unavailable");
const plain = (v) => v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const MAX_BYTES = 2_097_152;
function acknowledge(value) {
  if (value && typeof value.then === "function") { Promise.resolve(value).catch(() => undefined); throw unavailable(); }
  if (value !== undefined) throw unavailable();
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
 * INTERNAL transport-independent fixed-source revision/lease gate. No construction IO
 * or callback execution. Reads both fresh bounded single-link regular files per assertion,
 * with synchronous runtime authority before/after; missing user is valid only for null hash.
 * Observed failures and swallowed reentrancy permanently fence this instance, even after
 * byte/lease restoration. Reprepare expected revisions and bind a fresh generation/gate.
 * Does NOT validate SDK config/identities, attest ACLs, write/create files, reload or publish
 * sessions. No caller paths, cwd/env discovery, migration, locks, CAS, sandbox or cross-process
 * ownership. Cooperative generation prevents ABA only if every writer invalidates it first;
 * unobserved external ABA and ancestor/TOCTOU races remain outside this check. Private only.
 */
export function createBackendMcpConfigRevisionCheck(options) {
  try {
    const keys = ["agentDir", "bundledConfigPath", "expectedSha256", "expectedBundledSha256", "assertRuntimeOwner"];
    if (!plain(options) || !keys.every((k) => Object.hasOwn(options, k))
      || Reflect.ownKeys(options).some((k) => !keys.includes(k))) throw unavailable();
    const captured = Object.fromEntries(keys.map((k) => [k, options[k]]));
    if (typeof captured.agentDir !== "string" || !isAbsolute(captured.agentDir)
      || typeof captured.bundledConfigPath !== "string" || !isAbsolute(captured.bundledConfigPath)
      || (captured.expectedSha256 !== null && !digest(captured.expectedSha256)) || !digest(captured.expectedBundledSha256)
      || typeof captured.assertRuntimeOwner !== "function") throw unavailable();
    const agentDir = resolve(captured.agentDir), configPath = join(agentDir, "mcp.json"), bundledPath = resolve(captured.bundledConfigPath);
    const compare = (p) => process.platform === "win32" ? p.toLowerCase() : p;
    if (compare(configPath) === compare(bundledPath)) throw unavailable();
    let fenced = false, checking = false;
    return () => {
      try {
        if (fenced || checking) throw unavailable();
        checking = true;
        acknowledge(captured.assertRuntimeOwner());
        if (fenced) throw unavailable();
        const directory = fs.lstatSync(agentDir);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw unavailable();
        if (revision(configPath, true) !== captured.expectedSha256 || revision(bundledPath, false) !== captured.expectedBundledSha256) throw unavailable();
        acknowledge(captured.assertRuntimeOwner());
        if (fenced) throw unavailable();
      } catch { fenced = true; throw unavailable(); }
      finally { checking = false; }
    };
  } catch { throw unavailable(); }
}
