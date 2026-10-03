import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
const plain = (v) => v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, keys) => plain(v) && keys.every((key) => Object.hasOwn(v, key));
const only = (v, keys) => Reflect.ownKeys(v).every((key) => keys.includes(key));
const unavailable = () => new Error("MCP configuration update unavailable");
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function synchronous(v) {
  if (v && typeof v.then === "function") { Promise.resolve(v).catch(() => undefined); throw unavailable(); }
  return v;
}
const acknowledge = (v) => { if (synchronous(v) !== undefined) throw unavailable(); };

/**
 * INTERNAL SDK synchronous updateConfig boundary. Construction reads only the captured
 * successful loader callback; no coordinator/IO/runtime calls or ambient path discovery.
 * Fixed global source/server whitelist; never forwards or evaluates caller entry.config.
 * Settings-only enabled/exposure patches, captured once, detached/frozen. Mandatory
 * assertSnapshotOwner checks the published snapshot/generation BEFORE coordinator entry;
 * observed failure permanently fences this updater. It is not checked after entry because
 * accepting this write intentionally invalidates that generation. The required
 * synchronous Backend IO service receives fixed paths + BOTH expected source revisions;
 * it MUST recheck revisions/native document/server under its file exclusion, attest private
 * storage and check the writer scope before atomic commit. This module does NOT implement
 * those file/permission/lock/CAS guarantees or migration, reload/publication, credentials,
 * connections, project writes or a default SDK writer fallback. Requests are PRIVATE.
 * Exactly one synchronous coordinator callback/undefined acknowledgment is required.
 * Once the callback starts, success OR failure permanently consumes this updater snapshot;
 * reprepare/rebind after each attempt. Busy rejection before entry and invalid selectors
 * do not consume it. No rollback or auto-reactivation. Errors contain no paths/causes.
 */
export function createBackendMcpConfigUpdater(options) {
  try {
    const keys = ["agentDir", "bundledConfigPath", "prepared", "coordinator", "assertSnapshotOwner", "writeConfig"];
    if (!own(options, keys) || !only(options, keys)) throw unavailable();
    const captured = Object.fromEntries(keys.map((key) => [key, options[key]]));
    if (typeof captured.agentDir !== "string" || !isAbsolute(captured.agentDir)
      || typeof captured.bundledConfigPath !== "string" || !isAbsolute(captured.bundledConfigPath)
      || typeof captured.writeConfig !== "function" || types.isAsyncFunction(captured.writeConfig)
      || typeof captured.assertSnapshotOwner !== "function" || types.isAsyncFunction(captured.assertSnapshotOwner)
      || !own(captured.coordinator, ["runWriteSync"])) throw unavailable();
    const runWriteSync = captured.coordinator.runWriteSync;
    if (typeof runWriteSync !== "function" || types.isAsyncFunction(runWriteSync)) throw unavailable();
    const configPath = join(resolve(captured.agentDir), "mcp.json"), bundledConfigPath = resolve(captured.bundledConfigPath);
    const comparable = (p) => process.platform === "win32" ? p.toLowerCase() : p;
    if (comparable(configPath) === comparable(bundledConfigPath)) throw unavailable();
    const preparedKeys = ["ok", "issues", "sourceSha256", "bundledSha256", "serverCount", "loadConfig"];
    if (!own(captured.prepared, preparedKeys)) throw unavailable();
    const prepared = Object.fromEntries(preparedKeys.map((key) => [key, captured.prepared[key]]));
    if (prepared.ok !== true || !Array.isArray(prepared.issues) || prepared.issues.length !== 0
      || (prepared.sourceSha256 !== null && !digest(prepared.sourceSha256)) || !digest(prepared.bundledSha256)
      || !Number.isSafeInteger(prepared.serverCount) || prepared.serverCount < 0 || typeof prepared.loadConfig !== "function") throw unavailable();
    const snapshot = structuredClone(synchronous(prepared.loadConfig()));
    if (!own(snapshot, ["servers", "errors"]) || !Array.isArray(snapshot.servers) || snapshot.servers.length !== prepared.serverCount
      || !Array.isArray(snapshot.errors) || snapshot.errors.length !== 0) throw unavailable();
    const names = new Set(), namespaces = new Set();
    for (const entry of snapshot.servers) {
      if (!own(entry, ["name", "source", "scope", "config"]) || typeof entry.name !== "string"
        || !/^[A-Za-z0-9_-]+$/.test(entry.name) || !plain(entry.config) || entry.source !== configPath || entry.scope !== "global") throw unavailable();
      const namespace = entry.name.replaceAll("-", "_");
      if (names.has(entry.name) || namespaces.has(namespace)) throw unavailable();
      names.add(entry.name); namespaces.add(namespace);
    }
    let consumed = false, checkingSnapshot = false;
    const run = (entry, payload) => {
      try {
        if (checkingSnapshot) { consumed = true; throw unavailable(); }
        if (consumed || !own(entry, ["name", "source", "scope", "config"])
          || !only(entry, ["name", "source", "scope", "config"])) throw unavailable();
        const name = entry.name, source = entry.source, scope = entry.scope;
        if (!names.has(name) || source !== configPath || scope !== "global") throw unavailable();
        const request = Object.freeze({ configPath, bundledConfigPath, expectedSha256: prepared.sourceSha256,
          expectedBundledSha256: prepared.bundledSha256, serverName: name, ...payload });
        try {
          checkingSnapshot = true; acknowledge(captured.assertSnapshotOwner());
          if (consumed) throw unavailable();
        } catch { consumed = true; throw unavailable(); }
        finally { checkingSnapshot = false; }
        let entered = 0, completed = false, open = true;
        try {
          acknowledge(runWriteSync((writerScope) => {
            if (!open || entered++ !== 0 || consumed) throw unavailable();
            consumed = true;
            if (!own(writerScope, ["assertOwner"])) throw unavailable();
            const assertOwner = writerScope.assertOwner;
            if (typeof assertOwner !== "function") throw unavailable();
            let active = true, valid = true, checkingOwner = false;
            const guard = Object.freeze({ assertOwner: () => {
              try {
                if (!open || !active || !valid || checkingOwner) throw unavailable();
                checkingOwner = true; acknowledge(assertOwner());
                if (!open || !active || !valid) throw unavailable();
              } catch { valid = false; throw unavailable(); }
              finally { checkingOwner = false; }
            } });
            try {
              guard.assertOwner(); acknowledge(captured.writeConfig(request, guard)); guard.assertOwner();
              completed = true;
              return undefined;
            } finally { active = false; }
          }));
          if (entered !== 1 || !completed) throw unavailable();
        } finally { open = false; }
      } catch { throw unavailable(); }
    };
    /** SDK contract: settings-only patches. */
    const updater = (entry, patch) => {
      try {
        if (!plain(patch) || !only(patch, ["enabled", "exposure"])) throw unavailable();
        const settings = {};
        if (Object.hasOwn(patch, "enabled")) { const enabled = patch.enabled; if (typeof enabled !== "boolean") throw unavailable(); settings.enabled = enabled; }
        if (Object.hasOwn(patch, "exposure")) { const exposure = patch.exposure; if (!["codemode", "deferred", "direct", "hidden"].includes(exposure)) throw unavailable(); settings.exposure = exposure; }
        if (Object.keys(settings).length === 0) throw unavailable();
        run(entry, { patch: Object.freeze(settings) });
      } catch { throw unavailable(); }
    };
    /** Owner-only auth write: bounded header values, null removes; never the SDK settings path. */
    updater.writeHeaders = (entry, headers) => {
      try {
        const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
        if (!plain(headers) || Reflect.ownKeys(headers).length === 0) throw unavailable();
        const copy = {};
        for (const key of Reflect.ownKeys(headers)) {
          const value = headers[key];
          if (typeof key !== "string" || key.length > 256 || !headerName.test(key)
            || (value !== null && (typeof value !== "string" || value.length > 8192 || /[\0\r\n]/.test(value)))) throw unavailable();
          copy[key] = value;
        }
        run(entry, { headers: Object.freeze(copy) });
      } catch { throw unavailable(); }
    };
    return updater;
  } catch { throw unavailable(); }
}
