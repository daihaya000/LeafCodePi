import { join } from "node:path";
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
  const mcp = Object.hasOwn(options, "mcp") ? options.mcp : undefined;
  if (!plain(mcp) || Object.keys(mcp).some((key) => !["credentials", "openUrl", "updateConfig", "createTransport", "startupWaitMs"].includes(key))) {
    return failed("mcp-owner-services-required");
  }
  // Capture handles once: a getter must not change a validated service into an SDK default.
  const services = {};
  for (const key of ["credentials", "openUrl", "updateConfig", "createTransport", "startupWaitMs"]) {
    if (Object.hasOwn(mcp, key)) services[key] = mcp[key];
  }
  if (!["credentials", "openUrl", "updateConfig"].every((key) => Object.hasOwn(services, key))
    || !services.credentials || typeof services.credentials !== "object"
    || !["forServer", "tokens", "remove"].every((key) => typeof services.credentials[key] === "function")
    || typeof services.openUrl !== "function" || typeof services.updateConfig !== "function"
    || (Object.hasOwn(services, "createTransport") && typeof services.createTransport !== "function")
    || (Object.hasOwn(services, "startupWaitMs") && (!Number.isSafeInteger(services.startupWaitMs) || services.startupWaitMs < 0 || services.startupWaitMs > 60_000))) {
    return failed("invalid-mcp-owner-services");
  }
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
    factories: [createCodemodeExtension({ mode: "on", models: false }), createToolSearchExtension(), createMcpExtension(nativeOptions)],
  };
}

export async function prepareBackendMcpExtensions(options = {}) {
  try { return await assembleNativeExtensions(options); }
  catch { return failed("native-extension-preparation-failed"); }
}
