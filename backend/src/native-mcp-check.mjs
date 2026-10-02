#!/usr/bin/env node
/**
 * Read-only native MCP cutover check. Writes nothing: no config, credential, lock or session file.
 * Steps: opt-in flag, private-storage attestation, config load/validation, bundled adapter presence,
 * and (only with `--connect`) a real per-server handshake (initialize + tools/list, never a tool call)
 * against every enabled server through the native transports.
 *
 * `--skip-storage` is for transport compatibility only and is NOT acceptance: it bypasses the same
 * attestation the runtime requires, so a passing run there does not mean native MCP may be enabled.
 * `--json` prints one machine-readable object (still no secrets/paths/tokens).
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { McpClient } from "@earendil-works/pi-mcp";
import { createBackendMcpConfigStorageCheck, createBackendMcpPrivateStorageCheck } from "../core/mcp-private-storage.mjs";
import { prepareBackendMcpConfigLoader } from "../core/mcp-native-config-loader.mjs";
import { createBackendMcpNativeRuntime } from "../core/mcp-native-runtime.mjs";
import { createBackendMcpHttpTransportFactory } from "../core/mcp-native-http-transport.mjs";
import { createBackendMcpStdioTransportFactory } from "../core/mcp-native-stdio-transport.mjs";
import { isNativeMcpRequested } from "./mcp-native-activation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_CONFIG = resolve(HERE, "..", "..", "extensions", "leafcode-mcp-adapter", "mcp.json");
const ADAPTER_ENTRY = resolve(HERE, "..", "..", "extensions", "leafcode-mcp-adapter", "index.ts");

/** Runs the check and returns a report. Never throws for an expected refusal. */
export async function runNativeMcpCheck(options = {}) {
  const env = options.env ?? process.env;
  const agentDir = options.agentDir ?? getAgentDir();
  const skipStorage = options.skipStorage === true;
  const report = { ok: false, nativeRequested: isNativeMcpRequested(env), storage: "skipped", servers: [], connect: null, issues: [], adapterPresent: existsSync(options.adapterEntry ?? ADAPTER_ENTRY) };

  if (!skipStorage) {
    const configPath = resolve(agentDir, "mcp.json"), credentialPath = resolve(agentDir, "mcp-auth.json");
    for (const [label, check, location] of [
      ["config", createBackendMcpConfigStorageCheck({ agentDir }), { agentDir, configPath }],
      ["credentials", createBackendMcpPrivateStorageCheck({ agentDir }), { agentDir, credentialPath }],
    ]) {
      try { check(location); }
      catch { report.issues.push(`${label}-storage-refused`); report.storage = "refused"; }
    }
    if (report.storage === "refused") return report;
    report.storage = "ok";
  }

  const loaded = await prepareBackendMcpConfigLoader({ agentDir, bundledConfigPath: options.bundledConfigPath ?? BUNDLED_CONFIG, urlVariables: { ...env } });
  if (!loaded.ok) {
    report.issues.push(...loaded.issues.map((issue) => issue.code));
    return report;
  }
  const snapshot = loaded.loadConfig();
  report.servers = snapshot.servers.map(({ name, config }) => ({
    name, enabled: config.enabled !== false, transport: typeof config.url === "string" ? "http" : "stdio", exposure: config.exposure ?? "codemode",
  }));
  if (options.connect !== true) { report.ok = true; return report; }

  // Real handshake per enabled server through the native transports. Servers start exactly as a
  // session would start them; only initialize/tools-list run, never a tool call.
  const runtime = createBackendMcpNativeRuntime({
    agentDir, bundledConfigPath: options.bundledConfigPath ?? BUNDLED_CONFIG, homeDir: options.homeDir ?? homedir(),
    environment: { ...env }, variables: { ...env }, fetch: options.fetch ?? globalThis.fetch,
    openUrl() { report.connect = { ...report.connect, browserRequested: true }; },
    assertProcessOwner() {}, startupWaitMs: 0,
    ...(skipStorage ? { storageChecks: { config() {}, credentials() {} } } : {}),
  });
  try {
    const prepared = await runtime.prepare();
    const fresh = prepared.binding.loadConfig();
    const sessionCwd = options.sessionCwd ?? process.cwd();
    const common = { snapshot: fresh, configPath: resolve(agentDir, "mcp.json"), sessionCwd, assertSnapshotOwner: prepared.binding.assertOwner };
    const stdioFactory = createBackendMcpStdioTransportFactory({ ...common, homeDir: options.homeDir ?? homedir(), environment: { ...env } });
    const httpFactory = createBackendMcpHttpTransportFactory({ ...common, variables: { ...env }, fetch: options.fetch ?? globalThis.fetch });
    const servers = {};
    for (const server of fresh.servers) {
      if (server.config.enabled === false) continue;
      // The adapter resolved `!command` env values itself; the native transports never execute config
      // commands, so name that reason instead of a generic refusal. The value stays private.
      const envCommands = Object.entries(server.config.env ?? {})
        .filter(([, value]) => typeof value === "string" && value.startsWith("!")).map(([key]) => key);
      if (envCommands.length) { servers[server.name] = { error: "unsupported-env-command", envKeys: envCommands }; continue; }
      let transport;
      try { transport = (typeof server.config.url === "string" ? httpFactory : stdioFactory)(server, sessionCwd, undefined); }
      catch { servers[server.name] = { error: "transport-refused" }; continue; }
      const client = new McpClient({ name: "leafcode-cutover-check", version: "0.1.0", requestTimeoutMs: options.connectTimeoutMs ?? 10_000 });
      try {
        await client.connect(transport);
        servers[server.name] = { tools: (await client.listTools()).length };
      } catch { servers[server.name] = { error: "handshake-failed" }; }
      finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
    }
    report.connect = { ...report.connect, servers, browserRequested: report.connect?.browserRequested === true };
    // Acceptance needs every enabled server to complete a handshake; exposure decides only which tools
    // the model sees, so a codemode server still has to answer tools/list.
    const enabled = fresh.servers.filter((server) => server.config.enabled !== false).map((server) => server.name);
    report.ok = enabled.length > 0 && enabled.every((name) => typeof servers[name]?.tools === "number");
    if (!report.ok) report.issues.push("enabled-servers-not-verified");
  } catch (error) {
    report.issues.push(error?.message === "MCP native runtime unavailable" ? "native-runtime-refused" : "connect-failed");
  } finally {
    runtime.dispose();
  }
  return report;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const json = args.has("--json");
  const options = { connect: args.has("--connect"), skipStorage: args.has("--skip-storage") };
  void runNativeMcpCheck(options).then((report) => {
    if (json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      process.stdout.write(`native flag requested: ${report.nativeRequested}\n`);
      process.stdout.write(`storage attestation: ${report.storage}${options.skipStorage ? " (SKIPPED: not acceptance)" : ""}\n`);
      process.stdout.write(`bundled adapter present: ${report.adapterPresent}\n`);
      for (const server of report.servers) process.stdout.write(`server ${server.name}: ${server.transport} ${server.exposure}${server.enabled ? "" : " (off)"}\n`);
      if (report.connect) {
        for (const [name, value] of Object.entries(report.connect.servers ?? {})) {
          process.stdout.write(`server ${name}: ${typeof value.tools === "number" ? `${value.tools} tools` : `${value.error}${value.envKeys ? ` (${value.envKeys.join(", ")})` : ""}`}\n`);
        }
      }
      if (report.issues.length) process.stdout.write(`issues: ${report.issues.join(", ")}\n`);
      process.stdout.write(`result: ${report.ok ? "ok" : "not ready"}\n`);
    }
    process.exit(report.ok ? 0 : 1);
  });
}

if (process.argv[1] && isAbsolute(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
