import { basename, isAbsolute, join } from "node:path";
import { types } from "node:util";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { prepareBackendMcpConfigLoader } from "./mcp-native-config-loader.mjs";

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
  const required = ["credentials", "openUrl", ...(includeUpdater ? ["updateConfig"] : [])];
  const allowed = [...required, "createTransport", "startupWaitMs"];
  if (!plain(mcp) || Reflect.ownKeys(mcp).some((key) => !allowed.includes(key))) return failed("mcp-owner-services-required");
  // Capture handles once: validated services must never become an SDK default through getters.
  const services = Object.fromEntries(allowed.filter((key) => Object.hasOwn(mcp, key)).map((key) => [key, mcp[key]]));
  if (!required.every((key) => Object.hasOwn(services, key))
    || !services.credentials || typeof services.credentials !== "object"
    || !["forServer", "tokens", "remove"].every((key) => typeof services.credentials[key] === "function")
    || typeof services.openUrl !== "function" || (includeUpdater && typeof services.updateConfig !== "function")
    || (Object.hasOwn(services, "createTransport") && typeof services.createTransport !== "function")
    || (Object.hasOwn(services, "startupWaitMs") && (!Number.isSafeInteger(services.startupWaitMs) || services.startupWaitMs < 0 || services.startupWaitMs > 60_000))) return failed("invalid-mcp-owner-services");
  return { ok: true, services };
}

/** INTERNAL synchronous composition from an already prepared owner binding. No loader,
 * reprepare, migration, activation or SDK config/storage/browser fallback. Factory registration
 * checks authority before and after (including async registration), but is NOT transactional:
 * callers must refuse publication after any registration error and rebind explicitly. This does
 * not fence already connected tools, cancel OAuth, or establish writer quiescence/permissions. */
export function prepareBackendMcpExtensionsFromBinding(options) {
  try {
    if (!plain(options) || !["binding", "mcp"].every((key) => Object.hasOwn(options, key))
      || Reflect.ownKeys(options).some((key) => !["binding", "mcp"].includes(key))) return failed("invalid-native-extension-options");
    const binding = options.binding, mcp = options.mcp;
    const keys = ["prepared", "assertOwner", "loadConfig", "updateConfig", "logPath"];
    if (!plain(binding) || !keys.every((key) => Object.hasOwn(binding, key))
      || Reflect.ownKeys(binding).some((key) => !keys.includes(key))) return failed("invalid-native-extension-binding");
    const captured = Object.fromEntries(keys.map((key) => [key, binding[key]]));
    if ([captured.assertOwner, captured.loadConfig, captured.updateConfig].some((fn) => typeof fn !== "function" || types.isAsyncFunction(fn))
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
      updateConfig, logPath: captured.logPath }).map((factory) => async (pi) => {
      try { assertBound(); await factory(pi); assertBound(); }
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
