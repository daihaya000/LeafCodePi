import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { prepareBackendMcpConfigLoader } from "./mcp-native-config-loader.mjs";
import { createBackendMcpWriteCoordinator } from "./mcp-native-write-coordinator.mjs";
import { createBackendMcpConfigRevisionCheck } from "./mcp-native-config-revision.mjs";
import { createBackendMcpConfigUpdater } from "./mcp-native-config-updater.mjs";
import { createBackendMcpConfigFileWriter } from "./mcp-native-config-file-writer.mjs";
const unavailable = () => new Error("MCP configuration owner unavailable");
const plain = (v) => v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function acknowledge(value) {
  if (value && typeof value.then === "function") { Promise.resolve(value).catch(() => undefined); throw unavailable(); }
  if (value !== undefined) throw unavailable();
}
function result(promise) {
  const safe = promise.catch(() => { throw unavailable(); });
  safe.catch(() => undefined); return safe;
}

/**
 * INTERNAL, inert, fixed-source config owner composition. Explicit process authority/private
 * storage required; no constructor IO/callbacks. prepare() invalidates prior bindings at
 * acceptance, serializes loader preparation with this owner's cooperative writers, rejects
 * superseded candidates, then binds fresh revision/lease/updater callbacks. Binding readiness
 * is NOT session activation or cross-process ownership. No project/env/default SDK fallback.
 * updateConfig is synchronous: entered writes close the binding even on failure/no-op; callers
 * MUST await a new prepare() and rebind consumers before further loads/saves. No automatic
 * reload/publication/rollback. Invalid selectors do not consume a valid binding.
 * runWrite is the same private FIFO for other cooperative owner operations; callbacks must
 * assert their scope before side effects after awaits. Every bypass/external writer still needs
 * separate quiescence/exclusion. drain is a snapshot, dispose fences but cannot force cancellation.
 * Loader migration planning does not apply migration or authorize native production cutover.
 * Paths/hashes/config/bindings/results are PRIVATE, never HTTP DTOs. Errors have no causes.
 */
export function createBackendMcpConfigOwner(options) {
  try {
    const required = ["agentDir", "bundledConfigPath", "assertProcessOwner", "assertPrivateStorage"];
    if (!plain(options) || !required.every((k) => Object.hasOwn(options, k))
      || Reflect.ownKeys(options).some((k) => ![...required, "urlVariables"].includes(k))) throw unavailable();
    const captured = Object.fromEntries(required.map((k) => [k, options[k]]));
    const variables = Object.hasOwn(options, "urlVariables") ? options.urlVariables : {};
    if (typeof captured.agentDir !== "string" || !isAbsolute(captured.agentDir)
      || typeof captured.bundledConfigPath !== "string" || !isAbsolute(captured.bundledConfigPath)
      || !plain(variables) || Reflect.ownKeys(variables).some((k) => typeof k !== "string")
      || [captured.assertProcessOwner, captured.assertPrivateStorage].some((fn) => typeof fn !== "function" || types.isAsyncFunction(fn))) throw unavailable();
    const urlVariables = Object.freeze(Object.fromEntries(Object.entries(variables)));
    if (Object.values(urlVariables).some((v) => typeof v !== "string")) throw unavailable();
    const agentDir = resolve(captured.agentDir), bundledConfigPath = resolve(captured.bundledConfigPath);
    const location = Object.freeze({ agentDir, configPath: join(agentDir, "mcp.json") });
    const writeConfig = createBackendMcpConfigFileWriter({ agentDir, bundledConfigPath, assertPrivateStorage: captured.assertPrivateStorage });
    const coordinator = createBackendMcpWriteCoordinator({ assertProcessOwner: captured.assertProcessOwner });
    let closed = false, sequence = 0n, current = null;
    const retire = () => { sequence++; current = null; };
    const attest = () => acknowledge(captured.assertPrivateStorage(location));
    const open = () => { if (closed) throw unavailable(); };
    const prepare = () => {
      try {
        open(); retire(); const ticket = sequence;
        const candidate = coordinator.runWrite(async (scope) => {
          scope.assertOwner(); attest();
          const prepared = await prepareBackendMcpConfigLoader({ agentDir, bundledConfigPath, urlVariables });
          scope.assertOwner();
          if (closed || ticket !== sequence || prepared.ok !== true) throw unavailable();
          attest();
          createBackendMcpConfigRevisionCheck({ agentDir, bundledConfigPath, expectedSha256: prepared.sourceSha256,
            expectedBundledSha256: prepared.bundledSha256, assertRuntimeOwner: scope.assertOwner })();
          if (closed || ticket !== sequence) throw unavailable();
          return prepared;
        });
        return result(candidate.then((prepared) => {
          if (closed || ticket !== sequence) throw unavailable();
          const lease = coordinator.beginGeneration();
          const checkRevision = createBackendMcpConfigRevisionCheck({ agentDir, bundledConfigPath,
            expectedSha256: prepared.sourceSha256, expectedBundledSha256: prepared.bundledSha256, assertRuntimeOwner: lease.assertOwner });
          let binding, verifying = false;
          const verify = () => {
            try {
              if (closed || ticket !== sequence || verifying) throw unavailable();
              verifying = true;
              checkRevision(); attest(); checkRevision();
              if (closed || ticket !== sequence) throw unavailable();
            } catch { lease.revoke(); throw unavailable(); }
            finally { verifying = false; }
          };
          const assertOwner = () => {
            try { if (current !== binding) throw unavailable(); verify(); }
            catch { if (current === binding) retire(); lease.revoke(); throw unavailable(); }
          };
          const loadConfig = () => { assertOwner(); return prepared.loadConfig(); };
          const updater = createBackendMcpConfigUpdater({ agentDir, bundledConfigPath, prepared, assertSnapshotOwner: assertOwner,
            coordinator: { runWriteSync: (work) => coordinator.runWriteSync((scope) => { retire(); return work(scope); }) }, writeConfig });
          binding = Object.freeze({ assertOwner, loadConfig,
            prepared: Object.freeze({ ...prepared, issues: Object.freeze([]), loadConfig }),
            updateConfig: (entry, patch) => {
              try { if (closed || current !== binding) throw unavailable(); updater(entry, patch); }
              catch { throw unavailable(); }
            } });
          verify(); current = binding; return binding;
        }));
      } catch { return result(Promise.reject(unavailable())); }
    };
    return Object.freeze({ prepare,
      runWrite: (work) => {
        try { open(); if (typeof work !== "function") throw unavailable(); retire(); return result(coordinator.runWrite(work)); }
        catch { return result(Promise.reject(unavailable())); }
      },
      drain: () => result(coordinator.drain()),
      dispose: () => { if (!closed) { closed = true; retire(); coordinator.dispose(); } },
    });
  } catch { throw unavailable(); }
}
