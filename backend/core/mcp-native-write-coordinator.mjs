import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { createBackendMcpGenerationOwner } from "./mcp-native-generation-lease.mjs";
const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const unavailable = () => new Error("MCP writer coordinator unavailable");
const rejected = () => { const promise = Promise.reject(unavailable()); promise.catch(() => undefined); return promise; };

/**
 * INTERNAL process-local cooperative FIFO writer barrier. No construction IO/callbacks.
 * Owns (never exposes) its generation manager; accepted writes invalidate old leases
 * synchronously, block all generation publication while pending, and never auto-reactivate.
 * Process ownership is explicit/synchronous, checked at acceptance/start/completion and
 * via the writer's scoped guard. Observed authority failure cancels older queued tickets.
 * Nested writes/drain from this coordinator's writer context are rejected, not hung.
 * SDK updateConfig is synchronous/NOT awaited: runWriteSync completes or throws inline,
 * only when the FIFO is idle (never jumps queued work). Its callback MUST return undefined;
 * detectable native async functions are refused before invocation; other thenables are consumed and
 * rejected, not force-cancelled. Type contract also excludes async callbacks.
 * No default store, file/config/credential operations, process lease or session activation.
 * Callbacks/results are PRIVATE; callers must whitelist results before HTTP/Web use.
 * Work errors are sanitized, not rolled back. A running callback cannot be force-cancelled:
 * it MUST assert its scope before commits/side effects after awaits. Dispose rejects future
 * work and fences active/queued results; drain waits accepted work, including disposed work.
 * Queue promises settle after preceding running work; drain is a snapshot, not a freeze.
 * All cooperative writers must use THIS instance; bypass/external writers still need
 * separate process/file exclusion, barriers, source revisions and controlled cutover.
 */
export function createBackendMcpWriteCoordinator(options) {
  try {
    if (!plain(options) || !Object.hasOwn(options, "assertProcessOwner")
      || Object.keys(options).some((key) => key !== "assertProcessOwner")) throw unavailable();
    const assertProcessOwner = options.assertProcessOwner;
    if (typeof assertProcessOwner !== "function") throw unavailable();
    const context = new AsyncLocalStorage(), token = Object.freeze({});
    let closed = false, pending = 0, checking = false, authorityEpoch = 0n, tail = Promise.resolve();
    const verifyProcess = () => {
      if (closed || checking) { authorityEpoch++; generation.invalidate(); throw unavailable(); }
      const expected = authorityEpoch;
      checking = true;
      try {
        const result = assertProcessOwner();
        if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => undefined); throw unavailable(); }
        if (result !== undefined || closed || authorityEpoch !== expected) throw unavailable();
      } catch { authorityEpoch++; generation.invalidate(); throw unavailable(); }
      finally { checking = false; }
    };
    const generation = createBackendMcpGenerationOwner({ assertProcessOwner: () => {
      if (closed || pending !== 0) throw unavailable();
      verifyProcess();
    } });
    const writerScope = (ticket, isActive) => Object.freeze({ assertOwner: () => {
      try {
        if (!isActive() || closed || ticket !== authorityEpoch) throw unavailable();
        verifyProcess();
        if (!isActive() || closed || ticket !== authorityEpoch) throw unavailable();
      } catch { throw unavailable(); }
    } });
    const publish = (method) => {
      try { if (closed || pending !== 0) throw unavailable(); return generation[method](); }
      catch { throw unavailable(); }
    };
    return Object.freeze({
      beginGeneration: () => publish("beginGeneration"),
      captureLease: () => publish("captureLease"),
      runWrite: (work) => {
        try {
          if (closed || typeof work !== "function" || context.getStore() === token) throw unavailable();
          verifyProcess();
          const ticket = authorityEpoch;
          pending++; generation.invalidate();
          const run = tail.then(async () => {
            let active = true;
            const scope = writerScope(ticket, () => active);
            try {
              scope.assertOwner();
              return await context.run(token, async () => { const result = await work(scope); scope.assertOwner(); return result; });
            } catch { generation.invalidate(); throw unavailable(); }
            finally { active = false; pending--; generation.invalidate(); }
          });
          tail = run.then(() => undefined, () => undefined);
          return run;
        } catch { return rejected(); }
      },
      runWriteSync: (work) => {
        let entered = false, active = false;
        try {
          if (closed || pending !== 0 || typeof work !== "function" || types.isAsyncFunction(work)
            || context.getStore() === token) throw unavailable();
          verifyProcess();
          const ticket = authorityEpoch;
          pending++; entered = true; active = true; generation.invalidate();
          const scope = writerScope(ticket, () => active);
          scope.assertOwner();
          const result = context.run(token, () => work(scope));
          if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => undefined); throw unavailable(); }
          if (result !== undefined) throw unavailable();
          scope.assertOwner();
        } catch { throw unavailable(); }
        finally { if (entered) { active = false; pending--; generation.invalidate(); } }
      },
      drain: () => context.getStore() === token ? rejected() : tail,
      dispose: () => { if (!closed) { closed = true; authorityEpoch++; generation.dispose(); tail.then(() => context.disable()); } },
    });
  } catch { throw unavailable(); }
}
