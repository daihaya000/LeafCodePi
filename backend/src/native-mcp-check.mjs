#!/usr/bin/env node
/**
 * Read-only native MCP cutover check. Writes nothing: no config, credential, lock or session file.
 * Steps: opt-in flag, private-storage attestation, config load/validation, bundled adapter presence,
 * and (only with `--connect`) a real handshake against the configured servers through the native
 * transports. `--connect` starts local MCP servers exactly as a session would; it never calls a tool.
 * Registered MCP tools prove connectivity; exposure (codemode/deferred/direct) only decides which of
 * them the model sees, so a codemode server still registers its tools.
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
import { createBackendMcpConfigStorageCheck, createBackendMcpPrivateStorageCheck } from "../core/mcp-private-storage.mjs";
import { prepareBackendMcpConfigLoader } from "../core/mcp-native-config-loader.mjs";
import { createBackendMcpNativeRuntime } from "../core/mcp-native-runtime.mjs";
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

  // Real handshake: local servers are started by the SDK, tools are only listed, never called.
  const runtime = createBackendMcpNativeRuntime({
    agentDir, bundledConfigPath: options.bundledConfigPath ?? BUNDLED_CONFIG, homeDir: options.homeDir ?? homedir(),
    environment: { ...env }, variables: { ...env }, fetch: options.fetch ?? globalThis.fetch,
    openUrl() { report.connect = { ...report.connect, browserRequested: true }; },
    assertProcessOwner() {}, startupWaitMs: 0,
    ...(skipStorage ? { storageChecks: { config() {}, credentials() {} } } : {}),
  });
  const tools = new Map(), events = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
    on(name, callback) { events.set(name, callback); }, getSettings: () => ({}), getMcpServers: () => [],
    getAllTools: () => [...tools.values()], getActiveTools: () => [...tools.keys()], setActiveTools() {},
  };
  try {
    const prepared = await runtime.prepare();
    const composed = prepared.forSession(options.sessionCwd ?? process.cwd());
    if (!composed.ok) { report.issues.push(...composed.issues.map((issue) => issue.code)); return report; }
    for (const factory of composed.factories) await factory(pi);
    const ctx = { cwd: options.sessionCwd ?? process.cwd(), mode: "print", modelRegistry: {}, ui: { notify() {} } };
    events.get("session_start")({}, ctx);
    const deadline = Date.now() + (options.connectTimeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      if ([...tools.keys()].some((name) => name.startsWith("mcp__"))) break;
      await new Promise((done) => setTimeout(done, 250));
    }
    const counts = {};
    for (const name of tools.keys()) {
      if (!name.startsWith("mcp__")) continue;
      const server = name.split("__")[1] ?? "unknown";
      counts[server] = (counts[server] ?? 0) + 1;
    }
    // Every MCP tool is registered in the plugin registry; exposure decides whether the model sees it
    // (codemode/deferred servers stay out of the tool declarations). So this counts real connections,
    // not the model-facing surface.
    const enabled = report.servers.filter((server) => server.enabled).map((server) => server.name);
    report.connect = { ...report.connect, registeredTools: counts, browserRequested: report.connect?.browserRequested === true,
      unverifiedServers: enabled.filter((name) => !Object.hasOwn(counts, name)) };
    await events.get("session_shutdown")?.({}, ctx);
    // Acceptance needs at least one enabled server connected end to end; empty/unverified servers are
    // reported separately instead of being presented as success or failure.
    report.ok = enabled.some((name) => Object.hasOwn(counts, name));
    if (!report.ok) report.issues.push("no-server-registered-tools");
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
      if (report.connect) process.stdout.write(`registered MCP tools: ${JSON.stringify(report.connect.registeredTools)}\n`);
      if (report.connect?.unverifiedServers?.length) process.stdout.write(`enabled servers without registered tools: ${report.connect.unverifiedServers.join(", ")}\n`);
      if (report.issues.length) process.stdout.write(`issues: ${report.issues.join(", ")}\n`);
      process.stdout.write(`result: ${report.ok ? "ok" : "not ready"}\n`);
    }
    process.exit(report.ok ? 0 : 1);
  });
}

if (process.argv[1] && isAbsolute(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
