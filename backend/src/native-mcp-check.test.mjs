import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runNativeMcpCheck } from "./native-mcp-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "native-mcp-check.mjs");
const bundledConfigPath = resolve(HERE, "..", "..", "extensions", "leafcode-mcp-adapter", "mcp.json");

async function emptyAgentDir(t) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-native-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the check is read-only, reports the bundled view and never creates config files", async (t) => {
  const agentDir = await emptyAgentDir(t);
  const report = await runNativeMcpCheck({ agentDir, skipStorage: true, connect: false, env: {} });
  assert.equal(report.ok, true); assert.equal(report.storage, "skipped"); assert.equal(report.nativeRequested, false);
  assert.deepEqual(await readdir(agentDir), [], "the check must not write locks, config or credentials");
  const byName = Object.fromEntries(report.servers.map((server) => [server.name, server]));
  assert.equal(byName.notion.enabled, false); assert.equal(byName.notion.transport, "http");
  assert.equal(byName.slack.enabled, false);
  // n8n is a disabled shipped default whose ${N8N_MCP_URL} is unresolved here, so it is dropped.
  assert.equal("n8n" in byName, false);
  assert.equal(report.servers.every((server) => ["stdio", "http"].includes(server.transport)), true);
});

test("the opt-in flag is reported without enabling anything", async (t) => {
  const agentDir = await emptyAgentDir(t);
  const report = await runNativeMcpCheck({ agentDir, skipStorage: true, env: { LEAFCODE_PI_MCP_NATIVE: "1" } });
  assert.equal(report.nativeRequested, true);
});

test("a configured URL variable is honoured and keeps its shipped entry", async (t) => {
  const agentDir = await emptyAgentDir(t);
  const report = await runNativeMcpCheck({ agentDir, skipStorage: true, env: { N8N_MCP_URL: "https://n8n.example.invalid/mcp" } });
  const n8n = report.servers.find((server) => server.name === "n8n");
  assert.equal(n8n.enabled, false); assert.equal(n8n.transport, "http");
});

test("an unreadable bundled config fails closed with a sanitized issue code", async (t) => {  const agentDir = await emptyAgentDir(t);
  const report = await runNativeMcpCheck({ agentDir, skipStorage: true, bundledConfigPath: join(agentDir, "missing.json") });
  assert.equal(report.ok, false); assert.deepEqual(report.issues, ["bundled-unreadable"]);
});

test("the CLI prints one JSON report and exits with the report result", async (t) => {
  const agentDir = await emptyAgentDir(t);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, LEAFCODE_PI_MCP_NATIVE: "" };
  const skipped = spawnSync(process.execPath, [SCRIPT, "--json", "--skip-storage"], { env, encoding: "utf8", timeout: 25_000 });
  assert.equal(skipped.status, 0, skipped.stderr);
  const parsed = JSON.parse(skipped.stdout.trim());
  assert.equal(parsed.ok, true); assert.equal(parsed.storage, "skipped"); assert.equal(parsed.adapterPresent, true);
  // With the real attestation the exit code follows the report instead of crashing either way.
  const attested = spawnSync(process.execPath, [SCRIPT, "--json"], { env, encoding: "utf8", timeout: 25_000 });
  const report = JSON.parse(attested.stdout.trim());
  assert.equal(report.storage === "ok", report.ok);
  assert.equal(attested.status, report.ok ? 0 : 1);
  if (!report.ok) assert.equal(report.issues.length > 0, true);
  assert.equal(JSON.stringify(report).includes("mcp-auth.json"), false);
});

test("connect handshakes every enabled server and fails acceptance when one cannot", async (t) => {
  const agentDir = await emptyAgentDir(t);
  // A shipped-only config has no enabled server at all: acceptance must fail instead of passing vacuously.
  const shipped = await runNativeMcpCheck({ agentDir, skipStorage: true, connect: true, env: {}, connectTimeoutMs: 2_000 });
  assert.equal(shipped.ok, false);
  assert.deepEqual(shipped.issues, ["enabled-servers-not-verified"]);
  assert.deepEqual(shipped.connect.servers, {});
  // An enabled server that exits immediately is reported per server instead of a silent success.
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { broken: { command: process.execPath, args: ["-e", "process.exit(1)"] } } }));
  const broken = await runNativeMcpCheck({ agentDir, skipStorage: true, connect: true, env: {}, connectTimeoutMs: 4_000 });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.connect.servers.broken, { error: "handshake-failed" });
  assert.equal(broken.issues.includes("enabled-servers-not-verified"), true);
});

test("an env value that needs the adapter's command resolution is reported per key", async (t) => {
  const agentDir = await emptyAgentDir(t);
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    fixture: { command: process.execPath, args: ["--version"], env: { OPENAI_API_KEY: "!private-command", OK: "literal" } },
  } }), { mode: 0o600 });
  const report = await runNativeMcpCheck({ agentDir, skipStorage: true, connect: true, env: {}, connectTimeoutMs: 3_000 });
  assert.equal(report.ok, false);
  assert.deepEqual(report.connect.servers.fixture, { error: "unsupported-env-command", envKeys: ["OPENAI_API_KEY"] });
  assert.equal(JSON.stringify(report).includes("private-command"), false);
  assert.equal(report.issues.includes("enabled-servers-not-verified"), true);
});

test("connect verifies a real local MCP server through the native stdio transport", async (t) => {
  const agentDir = await emptyAgentDir(t);
  const script = join(agentDir, "peer.mjs");
  await writeFile(script, `import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
lines.on('line', (line) => { const message = JSON.parse(line); if (message.id === undefined) return;
  if (message.method === 'initialize') send(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
  else if (message.method === 'tools/list') send(message.id, { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] });
  else throw Error('Unexpected fixture request'); });
lines.on('close', () => process.exit(0));\n`, { mode: 0o600 });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script] } } }), { mode: 0o600 });
  const report = await runNativeMcpCheck({ agentDir, skipStorage: true, connect: true, env: {}, connectTimeoutMs: 8_000 });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.deepEqual(report.connect.servers, { fixture: { tools: 1 } });
  assert.deepEqual(report.issues, []);
});
