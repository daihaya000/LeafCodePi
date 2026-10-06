#!/usr/bin/env node
/**
 * Read-only native MCP cutover check. Writes nothing: no config, credential, lock or session file.
 * Steps: opt-in flag, private-storage attestation, config load/validation, bundled adapter presence,
 * and (only with `--connect`) a real per-server handshake (initialize + tools/list, never a tool call)
 * against every enabled server through the native transports.
 *
 * `--skip-storage` is for transport compatibility only and is NOT acceptance: it bypasses the same
 * attestation the runtime requires, so a passing run there does not mean native MCP may be enabled.
 * `--json` prints one machine-readable object (still no secrets/paths/tokens). `--timeout-ms=N`
 * raises the per-server handshake timeout (default 30s; browser-use needs well over 10s to boot).
 */
import { dirname, isAbsolute, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { McpClient } from "@earendil-works/pi-mcp";
import { createBackendMcpConfigStorageCheck, createBackendMcpPrivateStorageCheck } from "../core/mcp-private-storage.mjs";
import { prepareBackendMcpConfigLoader } from "../core/mcp-native-config-loader.mjs";
import { createBackendMcpNativeRuntime } from "../core/mcp-native-runtime.mjs";
import { createBackendMcpHttpTransportFactory } from "../core/mcp-native-http-transport.mjs";
import { createBackendMcpStdioTransportFactory } from "../core/mcp-native-stdio-transport.mjs";
import { isNativeMcpRequested, runEnvCommand } from "./mcp-native-activation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_CONFIG = resolve(HERE, "..", "core", "mcp-defaults.json");
const DEFAULT_BUNDLE = resolve(HERE, "..", "runtime", "runtime.bundle.mjs");

/** Runs the check and returns a report. Never throws for an expected refusal. */
export async function runNativeMcpCheck(options = {}) {
  const env = options.env ?? process.env;
  const agentDir = options.agentDir ?? getAgentDir();
  const skipStorage = options.skipStorage === true;
  const report = { ok: false, nativeRequested: isNativeMcpRequested(env), storage: "skipped", servers: [], connect: null, issues: [] };
  // The Backend loads the BUILT bundle, so a bundle older than the sources cannot serve today's
  // native API (auth writes, lazy provider resolution). Reported always; acceptance fails on it.
  let bundle;
  try { bundle = readFileSync(options.bundlePath ?? DEFAULT_BUNDLE, "utf8").includes("removeOAuth") ? "current" : "stale"; }
  catch { bundle = "missing"; }
  report.bundle = bundle;

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
  if (bundle !== "current") report.issues.push("bundle-stale");

  // Real handshake per enabled server through the native transports. Servers start exactly as a
  // session would start them; only initialize/tools-list run, never a tool call.
  const failedCommands = new Set();
  const runtime = createBackendMcpNativeRuntime({
    agentDir, bundledConfigPath: options.bundledConfigPath ?? BUNDLED_CONFIG, homeDir: options.homeDir ?? homedir(),
    environment: { ...env }, variables: { ...env }, fetch: options.fetch ?? globalThis.fetch,
    openUrl() { report.connect = { ...report.connect, browserRequested: true }; },
    assertProcessOwner() {}, startupWaitMs: 0,
    // Same owner-side resolution the activation uses, so adapter-style `!command` values are exercised.
    // Failures are recorded here so the reason can name the key without running a command twice.
    envCommands: { run: (command) => {
      const value = (options.runEnvCommand ?? runEnvCommand)(command);
      if (typeof value !== "string" || value.length === 0) failedCommands.add(command);
      return value;
    } },
    ...(skipStorage ? { storageChecks: { config() {}, credentials() {} } } : {}),
  });
  try {
    const prepared = await runtime.prepare();
    const fresh = prepared.snapshot;
    const sessionCwd = options.sessionCwd ?? process.cwd();
    const common = { snapshot: fresh, configPath: resolve(agentDir, "mcp.json"), sessionCwd, assertSnapshotOwner: prepared.binding.assertOwner };
    const stdioFactory = createBackendMcpStdioTransportFactory({ ...common, homeDir: options.homeDir ?? homedir(), environment: { ...env } });
    const httpFactory = createBackendMcpHttpTransportFactory({ ...common, variables: { ...env }, fetch: options.fetch ?? globalThis.fetch });
    const enabledServers = fresh.servers.filter((server) => server.config.enabled !== false);
    // Handshake independently: browser-use can take tens of seconds to start, and serial checks
    // would make every later server pay that startup delay too.
    const results = await Promise.all(enabledServers.map(async (server) => {
      let transport;
      try { transport = (typeof server.config.url === "string" ? httpFactory : stdioFactory)(server, sessionCwd, undefined); }
      catch {
        // The adapter resolved `!command` env values itself; the native transports never execute config
        // commands, so name the keys the owner could not resolve instead of a generic refusal.
        const envKeys = Object.entries(server.config.env ?? {})
          .filter(([, value]) => typeof value === "string" && value.startsWith("!") && failedCommands.has(value.slice(1))).map(([key]) => key);
        return [server.name, envKeys.length ? { error: "unsupported-env-command", envKeys } : { error: "transport-refused" }];
      }
      const client = new McpClient({ name: "leafcode-cutover-check", version: "0.1.0", requestTimeoutMs: options.connectTimeoutMs ?? 30_000 });
      try {
        await client.connect(transport);
        return [server.name, { tools: (await client.listTools()).length }];
      } catch { return [server.name, { error: "handshake-failed" }]; }
      finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
    }));
    // Promise.all retains config order, keeping the JSON report deterministic despite variable startup times.
    const servers = Object.fromEntries(results);
    report.connect = { ...report.connect, servers, browserRequested: report.connect?.browserRequested === true };
    // Acceptance needs every enabled server to complete a handshake; exposure decides only which tools
    // the model sees, so a codemode server still has to answer tools/list.
    const enabled = fresh.servers.filter((server) => server.config.enabled !== false).map((server) => server.name);
    report.ok = enabled.length > 0 && enabled.every((name) => typeof servers[name]?.tools === "number")
      && !report.issues.includes("bundle-stale");
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
  const timeout = [...args].find((value) => value.startsWith("--timeout-ms="));
  const options = { connect: args.has("--connect"), skipStorage: args.has("--skip-storage"),
    ...(timeout ? { connectTimeoutMs: Number(timeout.slice("--timeout-ms=".length)) } : {}) };
  void runNativeMcpCheck(options).then((report) => {
    if (json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      process.stdout.write(`native flag requested: ${report.nativeRequested}\n`);
      process.stdout.write(`storage attestation: ${report.storage}${options.skipStorage ? " (SKIPPED: not acceptance)" : ""}\n`);
      process.stdout.write(`bundled defaults: ${report.servers.length > 0 ? "loaded" : "none"}\n`);
      process.stdout.write(`runtime bundle: ${report.bundle}\n`);
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
