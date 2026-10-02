import { join } from "node:path";
import { createBackendMcpConfigOwner } from "./mcp-native-config-owner.mjs";
import { createBackendMcpCredentialAuthority } from "./mcp-native-credential-authority.mjs";
import { createBackendMcpCredentialOwner } from "./mcp-native-credential-owner.mjs";
import { createBackendMcpCredentials } from "./mcp-native-credentials.mjs";
import { prepareBackendMcpExtensionsFromBinding } from "./mcp-native-extensions.mjs";
import { createBackendMcpHttpTransportFactory } from "./mcp-native-http-transport.mjs";
import { createBackendMcpStdioTransportFactory } from "./mcp-native-stdio-transport.mjs";
import { createBackendMcpConfigStorageCheck, createBackendMcpPrivateStorageCheck } from "./mcp-private-storage.mjs";

const unavailable = () => new Error("MCP native runtime unavailable");
const plain = (v) => v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const sync = (fn) => typeof fn === "function" && fn.constructor?.name !== "AsyncFunction";
const REQUIRED = ["agentDir", "bundledConfigPath", "homeDir", "environment", "variables", "fetch", "openUrl", "assertProcessOwner"];
const ALLOWED = [...REQUIRED, "urlVariables", "startupWaitMs", "storageChecks"];

/** INTERNAL, INERT Backend composition of the native MCP owner pieces. Construction performs no IO.
 * prepare() reads/validates the fixed config sources once and returns a PRIVATE runtime bound to that
 * snapshot. forSession(cwd) returns SDK extension factories whose transports are chosen from the
 * prepared entry (url -> HTTP, otherwise stdio). Nothing here activates a session, migrates files,
 * quiesces other writers or removes the legacy adapter. Reprepare after any entered write/source change. */
export function createBackendMcpNativeRuntime(options) {
  try {
    if (!plain(options) || Reflect.ownKeys(options).some((key) => !ALLOWED.includes(key)) || !REQUIRED.every((key) => Object.hasOwn(options, key))) throw unavailable();
    const captured = Object.fromEntries(ALLOWED.filter((key) => Object.hasOwn(options, key)).map((key) => [key, options[key]]));
    if (typeof captured.agentDir !== "string" || typeof captured.bundledConfigPath !== "string" || typeof captured.homeDir !== "string"
      || !plain(captured.environment) || !plain(captured.variables) || typeof captured.fetch !== "function"
      || typeof captured.openUrl !== "function" || !sync(captured.assertProcessOwner)) throw unavailable();
    const checks = captured.storageChecks ?? {
      config: createBackendMcpConfigStorageCheck({ agentDir: captured.agentDir }),
      credentials: createBackendMcpPrivateStorageCheck({ agentDir: captured.agentDir }),
    };
    if (!plain(checks) || !sync(checks.config) || !sync(checks.credentials)) throw unavailable();
    const owner = createBackendMcpConfigOwner({
      agentDir: captured.agentDir, bundledConfigPath: captured.bundledConfigPath,
      ...(captured.urlVariables ? { urlVariables: captured.urlVariables } : {}),
      assertProcessOwner: captured.assertProcessOwner, assertPrivateStorage: checks.config,
    });
    let disposed = false;
    return Object.freeze({
      /** Returns a private per-binding runtime. Old bindings are retired by the config owner. */
      async prepare() {
        if (disposed) throw unavailable();
        let binding;
        try { binding = await owner.prepare(); } catch { throw unavailable(); }
        const authority = createBackendMcpCredentialAuthority({
          agentDir: captured.agentDir, bundledConfigPath: captured.bundledConfigPath,
          prepared: binding.prepared, assertRuntimeOwner: binding.assertOwner,
        });
        const credentials = createBackendMcpCredentials(createBackendMcpCredentialOwner({
          agentDir: captured.agentDir, assertOwner: authority, assertPrivateStorage: checks.credentials,
        }));
        const snapshot = binding.loadConfig(), configPath = join(captured.agentDir, "mcp.json");
        return Object.freeze({
          binding,
          /** One SDK extension family for one session cwd. No activation. */
          forSession(sessionCwd) {
            try {
            const common = { snapshot, configPath, sessionCwd, assertSnapshotOwner: binding.assertOwner };
            const stdioFactory = createBackendMcpStdioTransportFactory({ ...common, homeDir: captured.homeDir, environment: captured.environment });
            const httpFactory = createBackendMcpHttpTransportFactory({ ...common, variables: captured.variables, fetch: captured.fetch });
            return prepareBackendMcpExtensionsFromBinding({
              binding,
              mcp: {
                credentials, openUrl: captured.openUrl,
                createTransport: (entry, cwd, authProvider) => (entry?.config?.url !== undefined ? httpFactory : stdioFactory)(entry, cwd, authProvider),
                ...(captured.startupWaitMs === undefined ? {} : { startupWaitMs: captured.startupWaitMs }),
              },
            });
            } catch { throw unavailable(); }
          },
        });
      },
      runWrite: (work) => owner.runWrite(work),
      drain: () => owner.drain(),
      dispose() { disposed = true; owner.dispose(); },
    });
  } catch { throw unavailable(); }
}
