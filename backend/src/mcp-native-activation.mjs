import { spawn } from "node:child_process";
import { homedir, platform as osPlatform } from "node:os";

/** Bundled default config: the same file the migration planner reads. Overridable for tests/deployments. */
export const BUNDLED_MCP_CONFIG = new URL("../../extensions/leafcode-mcp-adapter/mcp.json", import.meta.url);

const ENABLED_VALUES = new Set(["1", "true", "yes", "on", "native"]);
const unavailable = () => new Error("MCP native activation unavailable");

/** Explicit opt-in only. Unset or any other value keeps the bundled adapter path. */
export function isNativeMcpRequested(env = process.env) {
  return ENABLED_VALUES.has(String(env?.LEAFCODE_PI_MCP_NATIVE ?? "").trim().toLowerCase());
}

/** Composition for the Backend entry: native MCP only when the runtime is attached AND the explicit
 * opt-in flag is set, so the adapter and the native path never run together. Returns the startup
 * hooks for `createBackendStartup` and the config-write path, or null to keep today's behavior. */
export function createNativeMcpStartup({ runtimeRequested, env = process.env, activation } = {}) {
  if (runtimeRequested !== true || !isNativeMcpRequested(env)) return null;
  const instance = activation ?? createNativeMcpActivation();
  return Object.freeze({
    initializeRuntime: (runtimeModule) => instance.initialize(runtimeModule),
    /** Config writes go through the owner's writer scope so the provider is republished afterwards. */
    runConfigWrite: (work) => instance.runConfigWrite(work),
  });
}

/** Browser launcher for a headless process: no shell, so an auth URL cannot become a command line. */
export function browserOpenCommand(platformName, url) {
  if (platformName === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platformName === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** Fire-and-forget opener. Only http(s) URLs are accepted; failures never carry the URL or OS text. */
export function createBrowserOpener({ platform: platformName = osPlatform(), launch = spawn } = {}) {
  return (url) => new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { reject(unavailable()); return; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") { reject(unavailable()); return; }
    const { command, args } = browserOpenCommand(platformName, parsed.href);
    let child;
    try { child = launch(command, args, { detached: true, stdio: "ignore", windowsHide: true }); }
    catch { reject(unavailable()); return; }
    child.once("error", () => reject(unavailable()));
    child.once("spawn", () => { try { child.unref?.(); } catch { /* unref is best-effort */ } resolve(undefined); });
  });
}

function records(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const result = {};
  for (const key of Reflect.ownKeys(value ?? {})) {
    if (typeof key !== "string") continue;
    const item = value[key];
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

/**
 * INTERNAL opt-in production wiring: assembles the private native MCP runtime from the attached
 * bundle and installs the session provider before the Backend publishes the runtime. Construction is
 * inert and does not import the SDK; the agent directory is resolved from `PI_CODING_AGENT_DIR` only
 * when `initialize` runs. Default (flag unset) never calls this. `install()` is the single
 * provider-installation path, so a stale owner without it refuses instead of leaving a half-built
 * runtime installed. Environment/variables are snapshotted
 * at construction as the explicit base for `${NAME}`/`$VAR` expansion (the default is the Backend
 * process environment, matching the adapter's inherited env); stdio children still launch with an
 * explicit env map rather than an implicit inheritance. Failure is sanitized and leaves the runtime
 * unpublished, but effects already started inside a failed attempt are not rolled back. This does
 * not migrate credentials/writers or remove the adapter.
 */
export function createNativeMcpActivation(options = {}) {
  try {
    const keys = ["agentDir", "bundledConfigPath", "homeDir", "environment", "variables", "fetch", "openUrl", "assertProcessOwner"];
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw unavailable();
    if (Reflect.ownKeys(options).some((key) => !keys.includes(key))) throw unavailable();
    const agentDir = Object.hasOwn(options, "agentDir") ? options.agentDir : undefined;
    if (agentDir !== undefined && (typeof agentDir !== "string" || !agentDir)) throw unavailable();
    const bundledConfigPath = Object.hasOwn(options, "bundledConfigPath") ? options.bundledConfigPath : BUNDLED_MCP_CONFIG;
    const homeDir = Object.hasOwn(options, "homeDir") ? options.homeDir : homedir();
    if (typeof homeDir !== "string" || !homeDir) throw unavailable();
    const environment = records(Object.hasOwn(options, "environment") ? options.environment : process.env);
    const variables = records(Object.hasOwn(options, "variables") ? options.variables : process.env);
    const fetch = Object.hasOwn(options, "fetch") ? options.fetch : globalThis.fetch;
    const openUrl = Object.hasOwn(options, "openUrl") ? options.openUrl : createBrowserOpener();
    const assertProcessOwner = Object.hasOwn(options, "assertProcessOwner") ? options.assertProcessOwner : () => {};
    if (typeof fetch !== "function" || typeof openUrl !== "function"
      || typeof assertProcessOwner !== "function" || assertProcessOwner.constructor?.name === "AsyncFunction") throw unavailable();

    let state = "idle";
    let owner;
    return Object.freeze({
      /** Installs the session provider and acknowledges with undefined. At most one successful attempt. */
      async initialize(runtimeModule) {
        if (state !== "idle") throw unavailable();
        if (!runtimeModule || typeof runtimeModule.createBackendMcpNativeRuntime !== "function") throw unavailable();
        state = "initializing";
        try {
          const directory = agentDir ?? (await import("@earendil-works/pi-coding-agent")).getAgentDir();
          owner = runtimeModule.createBackendMcpNativeRuntime({
            agentDir: directory, bundledConfigPath, homeDir,
            environment: { ...environment }, variables: { ...variables }, fetch, openUrl, assertProcessOwner,
          });
          if (typeof owner?.install !== "function") throw unavailable();
          await owner.install();
          state = "active";
          return undefined;
        } catch {
          try { owner?.dispose(); } catch { /* disposal is best-effort */ }
          owner = undefined;
          state = "failed";
          throw unavailable();
        }
      },
      /** Serializes one config write in the owner's writer scope, then republishes the provider so
       * later sessions see it. The write result is returned unchanged; if the republish fails, the
       * previous binding stays retired (fail-closed) and the failure is surfaced. */
      async runConfigWrite(work) {
        if (state !== "active" || !owner) throw unavailable();
        if (typeof work !== "function") throw unavailable();
        const result = await owner.runWrite((scope) => work(scope));
        try { await owner.install(); } catch { throw unavailable(); } // The write already happened; the republish failure is sanitized.
        return result;
      },
      /** Releases the config owner; already-installed providers/sessions are not revoked. */
      dispose() { try { owner?.dispose(); } catch { /* best-effort */ } state = "disposed"; },
      status: () => state,
    });
  } catch { throw unavailable(); }
}
