import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const unavailable = () => new Error("MCP credential store unavailable");
const MAX_BYTES = 2_097_152;
const sha = (value) => createHash("sha256").update(value).digest("hex");
function synchronousVoid(value) {
  if (value && typeof value.then === "function") Promise.resolve(value).catch(() => undefined);
  if (value !== undefined) throw unavailable();
}
function captureIdentity(value) {
  if (!plain(value) || Object.keys(value).some((key) => !["namespace", "serverUrl"].includes(key))
    || !["namespace", "serverUrl"].every((key) => Object.hasOwn(value, key))) throw unavailable();
  const id = Object.freeze({ namespace: value.namespace, serverUrl: value.serverUrl });
  if (typeof id.namespace !== "string" || !/^mcp__[A-Za-z0-9_]+$/.test(id.namespace)
    || typeof id.serverUrl !== "string" || /[\x00-\x20\x7f]/.test(id.serverUrl)) throw unavailable();
  const url = new URL(id.serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.href !== id.serverUrl) throw unavailable();
  return id;
}
const identityKey = (id) => `${id.namespace}|${id.serverUrl}`;
function jsonState(value, ancestors = new Set()) {
  if (value === undefined || value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw unavailable(); return; }
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) throw unavailable();
  ancestors.add(value);
  for (const item of Object.values(value)) jsonState(item, ancestors);
  ancestors.delete(value);
}
function copyState(state, id) {
  if (!plain(state)) throw unavailable();
  const copy = structuredClone(state);
  if (!Object.hasOwn(copy, "serverUrl") || copy.serverUrl !== id.serverUrl) throw unavailable();
  // The compatibility boundary validates token fields; never silently coerce Map/Date/NaN metadata.
  jsonState(copy);
  const text = JSON.stringify(copy);
  return JSON.parse(text);
}
function statFile(path) {
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw unavailable();
    return stat;
  } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
function readDocument(path) {
  const stat = statFile(path);
  if (!stat) return { values: Object.create(null), original: undefined, bom: "", newline: "\n", indent: "  ", ending: "\n" };
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_BYTES) throw unavailable();
    bytes = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = decoded.slice(bom.length);
  const values = JSON.parse(text);
  if (!plain(values) || /\r(?!\n)/.test(text) || (/\r\n/.test(text) && /(?<!\r)\n/.test(text))) throw unavailable();
  return { values: Object.assign(Object.create(null), values), original: sha(bytes), bom,
    newline: text.includes("\r\n") ? "\r\n" : "\n", indent: text.match(/^[\t ]+(?=")/m)?.[0] ?? "  ", ending: /\n$/.test(text) ? "\n" : "" };
}
function persist(path, doc, recheck) {
  const text = doc.bom + (JSON.stringify(doc.values, null, doc.indent) + doc.ending).replaceAll("\n", doc.newline);
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw unavailable();
  const temp = join(resolve(path, ".."), `.mcp-auth-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    recheck();
    const current = readDocument(path);
    if (current.original !== doc.original) throw unavailable();
    const existing = statFile(path);
    if (existing && process.platform !== "win32" && (existing.mode & 0o200) === 0) throw unavailable();
    fs.renameSync(temp, path);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

/**
 * INTERNAL, inactive until cutover. Fixed <agentDir>/mcp-auth.json only.
 * Constructor performs no IO. Caller must attest Backend ownership/configured identity
 * and private storage ACLs (mandatory on Windows; POSIX modes are additionally checked).
 * Existing private directory only: never creates directories or changes ACLs/modes.
 * Cooperating RMW writers use Pi's proper-lockfile protocol; refresh locks use its
 * per-identity SHA-256 name and 20s stale/10s heartbeat. Crash-stale refresh locks can
 * be recovered by that protocol; manual lock removal is NOT a supported recovery.
 * Atomic secret-file replacement inherits the approved directory's ACL; approve this
 * policy before real use. No legacy-key takeover, migration, config writes or connections.
 * Remove does NOT cancel an OAuth flow/refresh; cancellation/session fences are separate.
 * Local private storage only; short synchronous file transactions cannot renew a heartbeat
 * during blocking IO. Locks are not a sandbox/CAS against uncooperative writers.
 * File bytes are fsynced before rename; power-loss/Windows directory durability is not asserted.
 * Failures may be partial.
 */
export function createBackendMcpCredentialOwner(options) {
  try {
    const keys = ["agentDir", "assertOwner", "assertPrivateStorage"];
    if (!plain(options) || Object.keys(options).some((key) => !keys.includes(key))
      || !keys.every((key) => Object.hasOwn(options, key))) throw unavailable();
    const captured = Object.fromEntries(keys.map((key) => [key, options[key]]));
    if (typeof captured.agentDir !== "string" || !isAbsolute(captured.agentDir)
      || typeof captured.assertOwner !== "function" || typeof captured.assertPrivateStorage !== "function") throw unavailable();
    const agentDir = resolve(captured.agentDir), credentialPath = join(agentDir, "mcp-auth.json");
    const location = Object.freeze({ agentDir, credentialPath });
    const refreshLeases = new Map();
    const guard = (value) => {
      const id = captureIdentity(value);
      synchronousVoid(captured.assertOwner(id));
      synchronousVoid(captured.assertPrivateStorage(location));
      const dir = fs.lstatSync(agentDir);
      if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== "win32" && (dir.mode & 0o077) !== 0)
        || refreshLeases.get(identityKey(id))?.compromised) throw unavailable();
      return id;
    };
    const locked = (value, operation) => {
      let release;
      try {
        const id = guard(value);
        for (let attempt = 0; !release; attempt++) {
          try { release = lockfile.lockSync(credentialPath, { realpath: false, onCompromised: () => {} }); }
          catch (error) {
            if (error.code !== "ELOCKED" || attempt === 9) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          }
        }
        guard(id);
        return operation(id, readDocument(credentialPath));
      } catch { throw unavailable(); }
      finally { if (release) { try { release(); } catch { throw unavailable(); } } }
    };
    return Object.freeze({
      assertOwner: (value) => { try { guard(value); } catch { throw unavailable(); } },
      readState: (value) => locked(value, (id, doc) => Object.hasOwn(doc.values, identityKey(id)) ? copyState(doc.values[identityKey(id)], id) : undefined),
      writeState: (value, state) => locked(value, (id, doc) => {
        doc.values[identityKey(id)] = copyState(state, id);
        persist(credentialPath, doc, () => guard(id));
      }),
      removeState: (value) => locked(value, (id, doc) => {
        const key = identityKey(id);
        if (!Object.hasOwn(doc.values, key)) return false;
        delete doc.values[key];
        persist(credentialPath, doc, () => guard(id));
        return true;
      }),
      withRefreshLock: async (value, work) => {
        let id, release;
        const lease = { compromised: false };
        try {
          id = guard(value);
          if (typeof work !== "function") throw unavailable();
          const path = join(agentDir, `mcp-auth-refresh-${sha(identityKey(id)).slice(0, 16)}`);
          release = await lockfile.lock(path, { realpath: false, stale: 20_000,
            retries: { retries: 250, factor: 1, minTimeout: 100, maxTimeout: 100 },
            onCompromised: () => { lease.compromised = true; } });
          refreshLeases.set(identityKey(id), lease);
          guard(id);
        } catch {
          if (id && refreshLeases.get(identityKey(id)) === lease) refreshLeases.delete(identityKey(id));
          if (release) await release().catch(() => undefined);
          throw unavailable();
        }
        try {
          const result = await work();
          guard(id);
          return result;
        } finally {
          if (refreshLeases.get(identityKey(id)) === lease) refreshLeases.delete(identityKey(id));
          try { await release(); } catch { throw unavailable(); }
        }
      },
    });
  } catch { throw unavailable(); }
}
