import { basename, isAbsolute, join } from "node:path";
import { types } from "node:util";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { prepareBackendMcpConfigLoader } from "./mcp-native-config-loader.mjs";
import { registerBackendMcpNativeSessionShutdownAction } from "./mcp-native-session.mjs";

const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const failed = (code) => ({ ok: false, issues: [{ code }], factories: null });

/**
 * INTERNAL composition for a future Backend ResourceLoader. Does not construct
 * a session, dispatch session_start, activate tools, migrate files or connect.
 * Every invocation prepares a fresh fixed-owner snapshot. Source revisions must
 * still be checked under the writer barrier before binding a session.
 *
 * Credential storage, browser opening and config mutation MUST be supplied by
 * the owner: no SDK default credential file, browser or unsynchronized writer.
 * Default SDK transports are allowed only after the remaining cutover gates;
 * tests supply a transport sentinel. Codemode model access is explicitly off,
 * and mode "on" leaves existing direct declarations intact. Nested permission
 * gates remain mandatory; this is NOT a Bot/subagent authorization mechanism.
 * Old adapter exclusion, credential migration and activation are separate work.
 */
async function assembleNativeExtensions(options) {
  if (!plain(options) || Object.keys(options).some((key) => !["agentDir", "bundledConfigPath", "urlVariables", "mcp"].includes(key))) {
    return failed("invalid-native-extension-options");
  }
  const captured = captureOwnerServices(Object.hasOwn(options, "mcp") ? options.mcp : undefined, true);
  if (!captured.ok) return captured;
  const { services } = captured;
  const ownerOptions = {};
  for (const key of ["agentDir", "bundledConfigPath", "urlVariables"]) {
    if (Object.hasOwn(options, key)) ownerOptions[key] = options[key];
  }
  const prepared = await prepareBackendMcpConfigLoader(ownerOptions);
  if (!prepared.ok) return { ok: false, issues: prepared.issues, factories: null };
  const nativeOptions = {
    loadConfig: prepared.loadConfig,
    credentials: services.credentials,
    openUrl: services.openUrl,
    updateConfig: services.updateConfig,
    logPath: join(ownerOptions.agentDir, "mcp.log"),
    ...(Object.hasOwn(services, "createTransport") ? { createTransport: services.createTransport } : {}),
    ...(Object.hasOwn(services, "startupWaitMs") ? { startupWaitMs: services.startupWaitMs } : {}),
  };
  return {
    ok: true, issues: [], sourceSha256: prepared.sourceSha256, bundledSha256: prepared.bundledSha256, serverCount: prepared.serverCount,
    factories: nativeFactories(nativeOptions),
  };
}

function nativeFactories(options) {
  return [createCodemodeExtension({ mode: "on", models: false }), createToolSearchExtension(), createMcpExtension(options)];
}
function captureOwnerServices(mcp, includeUpdater) {
  const required = ["credentials", "openUrl", ...(includeUpdater ? ["updateConfig"] : ["createTransport"])];
  const allowed = [...new Set([...required, "createTransport", "startupWaitMs"])];
  if (!plain(mcp) || Reflect.ownKeys(mcp).some((key) => !allowed.includes(key))) return failed("mcp-owner-services-required");
  // Capture handles once: validated services must never become an SDK default through getters.
  const services = Object.fromEntries(allowed.filter((key) => Object.hasOwn(mcp, key)).map((key) => [key, mcp[key]]));
  if (!required.every((key) => Object.hasOwn(services, key))
    || !services.credentials || typeof services.credentials !== "object"
    || !["forServer", "tokens", "remove"].every((key) => typeof services.credentials[key] === "function")
    || typeof services.openUrl !== "function" || (includeUpdater && typeof services.updateConfig !== "function")
    || (Object.hasOwn(services, "createTransport") && (typeof services.createTransport !== "function"
      || (!includeUpdater && types.isAsyncFunction(services.createTransport))))
    || (Object.hasOwn(services, "startupWaitMs") && (!Number.isSafeInteger(services.startupWaitMs) || services.startupWaitMs < 0 || services.startupWaitMs > 60_000))) return failed("invalid-mcp-owner-services");
  return { ok: true, services };
}

// Explicit owner factory only: no SDK default transport. Constructor effects cannot be undone.
// start is fenced before/after awaiting; send/notifications/OAuth and started effects are not cancelled.
function guardTransportFactory(createTransport, assertBound) {
  const unavailable = () => new Error("MCP extension binding unavailable");
  return (...args) => {
    assertBound();
    let transport;
    try {
      transport = Reflect.apply(createTransport, undefined, args);
      if (transport && typeof transport.then === "function") {
        Promise.resolve(transport).catch(() => undefined); throw unavailable();
      }
      if (!transport || typeof transport !== "object") throw unavailable();
      const methods = Object.fromEntries(["start", "send", "close", "onMessage", "onError", "onClose"].map((key) => [key, transport[key]]));
      if (Object.values(methods).some((fn) => typeof fn !== "function")) throw unavailable();
      const start = async (...startArgs) => {
        assertBound();
        try { const result = await Reflect.apply(methods.start, transport, startArgs); assertBound(); return result; }
        catch (error) { assertBound(); throw error; }
      };
      const delegates = new WeakMap();
      // Shadow target supports frozen transports, preserves SDK instanceof StdioTransport/stderr,
      // and delegates private-field methods/getters to the original receiver. Cleanup stays unguarded.
      const guarded = new Proxy(Object.create(Object.getPrototypeOf(transport)), { get: (_target, key) => {
        if (key === "start") return start;
        const value = Reflect.get(transport, key, transport);
        if (typeof value !== "function") return value;
        if (!delegates.has(value)) delegates.set(value, value.bind(transport));
        return delegates.get(value);
      } });
      assertBound(); return guarded;
    } catch (error) {
      // The SDK cannot close an object the factory never returned to it. Best-effort only;
      // no rollback/drain guarantee, and cleanup failure must not revive this binding.
      try { if (transport && typeof transport.close === "function") Promise.resolve(transport.close()).catch(() => undefined); } catch {}
      assertBound(); throw error;
    }
  };
}

// Private SDK API view: executable registrations and connection-triggering lifecycle only.
// Metadata/exposure and the host tool pipeline remain intact. Late registrations stay guarded.
// Shutdown/other events pass through: cleanup must not depend on a valid config binding.
// No implicit cancellation, effect rollback, background connection drain or session reload.
function guardExecutionApi(pi, assertBound, onSessionStart) {
  const toolRegistration = pi.registerTool, commandRegistration = pi.registerCommand, eventRegistration = pi.on;
  if ([toolRegistration, commandRegistration, eventRegistration].some((fn) => typeof fn !== "function")) throw new Error("MCP extension binding unavailable");
  const wrap = (callback, receiver, tool) => {
    if (typeof callback !== "function") throw new Error("MCP extension binding unavailable");
    return async (...args) => {
      assertBound();
      if (tool && typeof args[3] === "function") {
        const onUpdate = args[3];
        args[3] = (...updates) => { assertBound(); return Reflect.apply(onUpdate, undefined, updates); };
      }
      try { const result = await Reflect.apply(callback, receiver, args); assertBound(); return result; }
      catch (error) { assertBound(); throw error; } // Preserve native errors only while the binding is valid.
    };
  };
  const registerTool = (definition) => {
    const captured = { ...definition };
    return Reflect.apply(toolRegistration, pi, [{ ...captured, execute: wrap(captured.execute, definition, true) }]);
  };
  const registerCommand = (name, definition) => {
    const captured = { ...definition };
    return Reflect.apply(commandRegistration, pi, [name, { ...captured, handler: wrap(captured.handler, definition, false) }]);
  };
  const on = (name, callback) => {
    if (!["session_start", "mcp_servers_change", "turn_start"].includes(name)) return Reflect.apply(eventRegistration, pi, [name, callback]);
    if (typeof callback !== "function") throw new Error("MCP extension binding unavailable");
    // Preserve synchronous handlers (notably session_start), return values, native errors while
    // valid, and the original unsubscribe. Do not treat background work as handler completion.
    const guarded = (...args) => {
      assertBound();
      try {
        if (name === "session_start") onSessionStart?.(args[1]);
        const result = Reflect.apply(callback, undefined, args);
        if (result && typeof result.then === "function") return Promise.resolve(result).then(
          (value) => { assertBound(); return value; }, (error) => { assertBound(); throw error; });
        assertBound(); return result;
      } catch (error) { assertBound(); throw error; }
    };
    const handler = types.isAsyncFunction(callback) ? async (...args) => guarded(...args) : guarded;
    return Reflect.apply(eventRegistration, pi, [name, handler]);
  };
  const delegates = new WeakMap();
  // Separate target also supports frozen host API properties without Proxy invariant violations.
  return new Proxy({}, { get: (_target, key) => {
    if (key === "registerTool") return registerTool;
    if (key === "registerCommand") return registerCommand;
    if (key === "on") return on;
    const value = Reflect.get(pi, key, pi);
    if (typeof value !== "function") return value;
    if (!delegates.has(value)) delegates.set(value, value.bind(pi));
    return delegates.get(value);
  } });
}

/** INTERNAL synchronous composition from an already prepared owner binding. No loader,
 * reprepare, migration, activation or SDK config/storage/browser fallback. Factory registration
 * checks authority before and after (including async registration), but is NOT transactional:
 * callers must refuse publication after any registration error and rebind explicitly. This
 * fences registered tool/command entry, progress and async completion, including existing connected
 * tools. Started callbacks can still have effects; a save can persist before command completion is
 * rejected. session_start/mcp_servers_change/turn_start entry and completion are guarded while
 * shutdown/other events and unsubscribe remain callable. Handler completion is NOT background
 * connection drain/cancellation. Explicit synchronous owner transport creation and start entry/completion
 * are guarded; close/listener cleanup and native transport classification remain intact. No send/notification/
 * OAuth force cancellation, full lifecycle side-effect fence,
 * writer quiescence or nested permission authorization. */
export function prepareBackendMcpExtensionsFromBinding(options) {
  try {
    if (!plain(options) || !["binding", "mcp"].every((key) => Object.hasOwn(options, key))
      || Reflect.ownKeys(options).some((key) => !["binding", "mcp"].includes(key))) return failed("invalid-native-extension-options");
    const binding = options.binding, mcp = options.mcp;
    const keys = ["prepared", "assertOwner", "loadConfig", "updateConfig", "writeAuthHeaders", "logPath"];
    if (!plain(binding) || !keys.every((key) => Object.hasOwn(binding, key))
      || Reflect.ownKeys(binding).some((key) => !keys.includes(key))) return failed("invalid-native-extension-binding");
    const captured = Object.fromEntries(keys.map((key) => [key, binding[key]]));
    if ([captured.assertOwner, captured.loadConfig, captured.updateConfig, captured.writeAuthHeaders]
      .some((fn) => typeof fn !== "function" || types.isAsyncFunction(fn))
      || typeof captured.logPath !== "string" || !isAbsolute(captured.logPath) || basename(captured.logPath) !== "mcp.log") return failed("invalid-native-extension-binding");
    let fenced = false, checking = false;
    const unavailable = () => new Error("MCP extension binding unavailable");
    const assertBound = () => {
      if (fenced || checking) { fenced = true; throw unavailable(); }
      checking = true;
      try {
        const ack = captured.assertOwner();
        if (ack && typeof ack.then === "function") { Promise.resolve(ack).catch(() => undefined); throw unavailable(); }
        if (ack !== undefined || fenced) throw unavailable();
      } catch { fenced = true; throw unavailable(); }
      finally { checking = false; }
    };
    assertBound();
    const prepared = captured.prepared;
    if (!plain(prepared)) return failed("invalid-native-extension-binding");
    const metadata = Object.fromEntries(["ok", "issues", "sourceSha256", "bundledSha256", "serverCount", "loadConfig"].map((key) => [key, prepared[key]]));
    const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (metadata.ok !== true || !Array.isArray(metadata.issues) || metadata.issues.length !== 0
      || !(metadata.sourceSha256 === null || hash(metadata.sourceSha256)) || !hash(metadata.bundledSha256)
      || !Number.isSafeInteger(metadata.serverCount) || metadata.serverCount < 0 || metadata.loadConfig !== captured.loadConfig) return failed("invalid-native-extension-binding");
    const ownerServices = captureOwnerServices(mcp, false);
    if (!ownerServices.ok) return ownerServices;
    const requireAvailable = () => { if (fenced || checking) { fenced = true; throw unavailable(); } };
    let sessionId, sessionManager;
    const captureSessionId = (context) => {
      let value, manager;
      try { manager = context?.sessionManager; value = manager?.getSessionId?.(); } catch { throw unavailable(); }
      if (typeof manager !== "object" || manager === null || typeof value !== "string" || !value
        || (sessionId !== undefined && (sessionId !== value || sessionManager !== manager))) throw unavailable();
      sessionId = value; sessionManager = manager;
    };
    const createTransport = guardTransportFactory((...args) => {
      const transport = Reflect.apply(ownerServices.services.createTransport, undefined, args);
      if (transport && typeof transport.then === "function") return transport;
      if (!sessionId || !sessionManager || !transport || typeof transport !== "object") throw unavailable();
      let config;
      try { config = args[0]?.config; } catch { throw unavailable(); }
      if (config && Object.hasOwn(config, "url")) return transport; // HTTP cleanup remains with session_shutdown; this registry targets child processes.
      let close, onClose;
      try { close = transport.close; onClose = transport.onClose; } catch { throw unavailable(); }
      if (typeof close !== "function" || typeof onClose !== "function") throw unavailable();
      const dispose = registerBackendMcpNativeSessionShutdownAction(sessionManager, () => Reflect.apply(close, transport, []));
      try { Reflect.apply(onClose, transport, [dispose]); } catch { dispose(); throw unavailable(); }
      return transport;
    }, assertBound);
    const consumeAsync = (value) => {
      if (value && typeof value.then === "function") { fenced = true; Promise.resolve(value).catch(() => undefined); throw unavailable(); }
    };
    const loadConfig = (ctx) => {
      requireAvailable();
      try { const loaded = captured.loadConfig(ctx); consumeAsync(loaded); return loaded; }
      catch { fenced = true; throw unavailable(); }
    };
    const updateConfig = (entry, patch) => {
      requireAvailable();
      try {
        const ack = captured.updateConfig(entry, patch);
        if (ack !== undefined) { fenced = true; consumeAsync(ack); throw unavailable(); }
        fenced = true; // Every successful entered owner save/no-op requires explicit prepare/rebind.
      } catch { throw unavailable(); } // Invalid selectors may leave the real owner binding retryable.
    };
    const factories = nativeFactories({ ...ownerServices.services, loadConfig,
      createTransport, updateConfig, logPath: captured.logPath }).map((factory) => async (pi) => {
      try { assertBound(); await factory(guardExecutionApi(pi, assertBound, captureSessionId)); assertBound(); }
      catch { fenced = true; throw unavailable(); }
    });
    assertBound();
    return { ok: true, issues: [], sourceSha256: metadata.sourceSha256, bundledSha256: metadata.bundledSha256,
      serverCount: metadata.serverCount, factories };
  } catch { return failed("native-extension-binding-failed"); }
}

export async function prepareBackendMcpExtensions(options = {}) {
  try { return await assembleNativeExtensions(options); }
  catch { return failed("native-extension-preparation-failed"); }
}
