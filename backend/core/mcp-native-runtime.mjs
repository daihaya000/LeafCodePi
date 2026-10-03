import { join } from "node:path";
import { createBackendMcpConfigOwner } from "./mcp-native-config-owner.mjs";
import { resolveMcpEnvCommands } from "./mcp-native-env-commands.mjs";
import { createBackendMcpCredentialAuthority } from "./mcp-native-credential-authority.mjs";
import { createBackendMcpCredentialOwner } from "./mcp-native-credential-owner.mjs";
import { createBackendMcpCredentials } from "./mcp-native-credentials.mjs";
import { createBackendMcpOAuthStatusReader } from "./mcp-native-oauth-status.mjs";
import { prepareBackendMcpExtensionsFromBinding } from "./mcp-native-extensions.mjs";
import { createBackendMcpHttpTransportFactory } from "./mcp-native-http-transport.mjs";
import { setBackendMcpNativeSessionProvider } from "./mcp-native-session.mjs";
import { createBackendMcpStdioTransportFactory } from "./mcp-native-stdio-transport.mjs";
import { createBackendMcpConfigStorageCheck, createBackendMcpPrivateStorageCheck } from "./mcp-private-storage.mjs";
import { publicMcpAuthSnapshot } from "../../shared/mcp-auth-snapshot.mjs";

const unavailable = () => new Error("MCP native runtime unavailable");
const plain = (v) => v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const sync = (fn) => typeof fn === "function" && fn.constructor?.name !== "AsyncFunction";
const only = (v, keys) => Reflect.ownKeys(v).every((k) => keys.includes(k));
const REQUIRED = ["agentDir", "bundledConfigPath", "homeDir", "environment", "variables", "fetch", "openUrl", "assertProcessOwner"];
const ALLOWED = [...REQUIRED, "urlVariables", "startupWaitMs", "storageChecks", "envCommands"];

/** INTERNAL, INERT Backend composition of the native MCP owner pieces. Construction performs no IO.
 * prepare() reads/validates the fixed config sources once and returns a PRIVATE runtime bound to that
 * snapshot. install() is the only provider-installation path (prepare + publish for new sessions).
 * forSession(cwd) returns SDK extension factories whose transports are chosen from the prepared entry
 * (url -> HTTP, otherwise stdio). Optional `envCommands.run` resolves adapter-style `!command`
 * env/header secrets in a private copy before the factories see them. Nothing here migrates files, reloads running sessions, quiesces other
 * writers or removes the legacy adapter; a failed reload leaves the previous provider fail-closed. */
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
    const envCommands = captured.envCommands;
    if (envCommands !== undefined && (!plain(envCommands) || !only(envCommands, ["run"]) || !sync(envCommands.run))) throw unavailable();
    const owner = createBackendMcpConfigOwner({
      agentDir: captured.agentDir, bundledConfigPath: captured.bundledConfigPath,
      ...(captured.urlVariables ? { urlVariables: captured.urlVariables } : {}),
      assertProcessOwner: captured.assertProcessOwner, assertPrivateStorage: checks.config,
    });
    let disposed = false;
    /** Returns a private per-binding runtime. Old bindings are retired by the config owner. */
    const prepareRuntime = async () => {
      if (disposed) throw unavailable();
      let binding;
      try { binding = await owner.prepare(); } catch { throw unavailable(); }
      const authority = createBackendMcpCredentialAuthority({
        agentDir: captured.agentDir, bundledConfigPath: captured.bundledConfigPath,
        prepared: binding.prepared, assertRuntimeOwner: binding.assertOwner,
      });
      const credentialOwner = createBackendMcpCredentialOwner({
        agentDir: captured.agentDir, assertOwner: authority, assertPrivateStorage: checks.credentials,
      });
      const credentials = createBackendMcpCredentials(credentialOwner);
      const readOAuthStatus = createBackendMcpOAuthStatusReader({ owner: credentialOwner });
      const loaded = binding.loadConfig();
      // Adapter-style `!command` secrets are resolved by the owner before the factories see them, so
      // the transports keep their "never execute configuration" property. Without an executor the
      // markers stay and the affected server is refused individually.
      const snapshot = envCommands ? resolveMcpEnvCommands(loaded, { run: envCommands.run }) : loaded;
      const configPath = join(captured.agentDir, "mcp.json");
      return Object.freeze({
        binding,
        /** PRIVATE resolved snapshot (env/header commands already substituted); never a DTO. */
        snapshot,
        /** Read-only native auth status for one configured entry of THIS snapshot. Never refreshes or
         * writes. Config headers win (they are what the runtime sends); otherwise the OAuth store is
         * consulted and non-credential endpoints report none. */
        readAuthStatus(name) {
          try {
            if (typeof name !== "string" || !name) throw unavailable();
            const entry = snapshot.servers.find((server) => server.name === name);
            if (!entry) throw unavailable();
            const url = typeof entry.config?.url === "string" && entry.config.url ? entry.config.url : undefined;
            const headers = plain(entry.config?.headers) ? entry.config.headers : undefined;
            const authorization = headers ? Object.keys(headers).find((key) => key.toLowerCase() === "authorization") : undefined;
            const snapshotValue = (authType, credentialConfigured, credentialSource, credentialStatus) =>
              publicMcpAuthSnapshot({ name, ...(url === undefined ? {} : { url }), authType, credentialConfigured, credentialSource, credentialStatus });
            if (authorization !== undefined) {
              const value = headers[authorization];
              const result = snapshotValue(typeof value === "string" && /^Bearer\s/i.test(value) ? "bearer" : "headers", true, "config", "present");
              if (!result) throw unavailable();
              return result;
            }
            if (headers && Object.keys(headers).length > 0) {
              const result = snapshotValue("headers", true, "config", "present");
              if (!result) throw unavailable();
              return result;
            }
            if (url === undefined) {
              const result = snapshotValue("none", false, "none", "missing");
              if (!result) throw unavailable();
              return result;
            }
            return readOAuthStatus(entry.name, url);
          } catch { throw unavailable(); }
        },
        /** PRIVATE OAuth-store-only status for one configured entry (authority whitelist applies). */
        readOAuthStatus(name) {
          try {
            if (typeof name !== "string" || !name) throw unavailable();
            const entry = snapshot.servers.find((server) => server.name === name);
            if (!entry || typeof entry.config?.url !== "string" || !entry.config.url) throw unavailable();
            return readOAuthStatus(entry.name, entry.config.url);
          } catch { throw unavailable(); }
        },
        /** Owner-only OAuth credential removal for one configured endpoint: clears the fixed native
         * store entry (authority-attested) and reports whether anything was stored. It does NOT cancel
         * an in-flight SDK refresh or a pending login (documented limitation). */
        removeOAuth(name) {
          try {
            if (typeof name !== "string" || !name) throw unavailable();
            const entry = snapshot.servers.find((server) => server.name === name);
            if (!entry || typeof entry.config?.url !== "string" || !entry.config.url) throw unavailable();
            return credentials.remove(entry.name, entry.config.url) === true;
          } catch { throw unavailable(); }
        },
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
    };

    /** Prepare a fresh binding and publish it as the process session provider (single install path). */
    const installRuntime = async () => {
      const prepared = await prepareRuntime();
      setBackendMcpNativeSessionProvider(prepared.forSession);
      return prepared;
    };

    return Object.freeze({
      prepare: prepareRuntime,
      /** Installs the fresh snapshot as the process session provider. A failed reload leaves the
       * previous provider in place — its retired binding then fails closed. New sessions only. */
      install: installRuntime,
      /** Owner-only auth write for one configured entry: prepares a fresh binding, writes bounded
       * header values through its guarded updater (which retires that binding) and republishes for
       * later sessions. Returns the fresh prepared handle; running sessions keep their snapshot. */
      async writeAuth(name, headers) {
        const prepared = await prepareRuntime();
        const entry = prepared.snapshot.servers.find((server) => server.name === name);
        if (!entry) throw unavailable();
        try { prepared.binding.writeAuthHeaders(entry, headers); } catch { throw unavailable(); }
        return installRuntime();
      },
      runWrite: (work) => owner.runWrite(work),
      drain: () => owner.drain(),
      dispose() { disposed = true; owner.dispose(); },
    });
  } catch { throw unavailable(); }
}
