import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, it } from "vitest";
import { createBackendMcpNativeRuntime } from "@backend-core/mcp-native-runtime.mjs";
import { nativeMcpExtensionFactory, setBackendMcpNativeSessionProvider } from "@backend-core/mcp-native-session.mjs";
import { captureNativeToolSearch, registerDeferredTools, type NativeToolSearch } from "./deferred-tools";
import { projectPiMessages } from "./messages";
import { sessionToolSelection } from "./session-tool-selection";

// A real stdio MCP server (a child process): `echo` repeats its text, `fail` returns an error result.
const PEER = `import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const tools = [
  { name: 'echo', description: 'Repeat the given text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'fail', description: 'Always reports an error', inputSchema: { type: 'object', properties: {} } },
];
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case 'initialize': send(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }); break;
    case 'tools/list': send(message.id, { tools }); break;
    case 'tools/call':
      if (message.params.name === 'fail') send(message.id, { isError: true, content: [{ type: 'text', text: 'fixture failure' }] });
      else send(message.id, { content: [{ type: 'text', text: 'echo: ' + message.params.arguments.text }] });
      break;
    default: throw Error('Unexpected fixture request');
  }
});
lines.on('close', () => process.exit(0));
`;

let root = "";
let session: AgentSession | undefined;
let disposeRuntime: (() => void) | undefined;
afterEach(async () => {
  try { session?.dispose(); } catch { /* best effort */ }
  session = undefined;
  setBackendMcpNativeSessionProvider(undefined);
  disposeRuntime?.();
  disposeRuntime = undefined;
  // The child may still be exiting and holding a file; Windows refuses to delete it until it is gone.
  for (let attempt = 0; root && attempt < 50; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  root = "";
});

/** The real native runtime, loader and tool selection, driven by a scripted model that issues one codemode call. */
async function run(code: string) {
  root = mkdtempSync(join(tmpdir(), "leafcode-native-codemode-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const script = join(root, "peer.mjs");
  writeFileSync(script, PEER, "utf8");
  // Native MCP refuses a server cwd outside the session directory, so the fixture stays inside it.
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script], cwd: root } } }), "utf8");
  writeFileSync(join(agentDir, "bundle.json"), "{}", "utf8");
  const runtime = createBackendMcpNativeRuntime({
    agentDir, bundledConfigPath: join(agentDir, "bundle.json"), homeDir: root,
    environment: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    variables: {}, fetch: async () => { throw new Error("No network"); }, openUrl() { throw new Error("No browser"); },
    assertProcessOwner() {}, storageChecks: { config() {}, credentials() {} },
  });
  disposeRuntime = () => runtime.dispose();
  const prepared = await runtime.prepare();
  setBackendMcpNativeSessionProvider((cwd: string) => prepared.forSession(cwd));

  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const nativeToolSearch: NativeToolSearch = {};
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    extensionFactories: [
      captureNativeToolSearch(nativeMcpExtensionFactory(root), nativeToolSearch),
      (api) => registerDeferredTools(api, undefined, nativeToolSearch),
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const registered = resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
  const picked = sessionToolSelection({ tools: ["read", "tool_search"], dynamicMcpTools: true, registered });
  assert.ok("excludeTools" in picked);

  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const created = await createAgentSession({
    cwd: root, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root),
    modelRuntime, model: faux.getModel(), excludeTools: picked.excludeTools,
  });
  session = created.session;
  session.setActiveToolsByName(picked.initialActive);
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  await session.prompt("fixtureで試して");
  return session;
}

function codemodeResult(target: AgentSession): { text: string; isError: boolean; nested: unknown } {
  for (const message of target.messages) {
    const result = message as { role?: string; toolName?: string; isError?: boolean; content?: unknown; nestedCalls?: unknown };
    if (result.role !== "toolResult" || result.toolName !== "codemode" || !Array.isArray(result.content)) continue;
    const text = result.content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
    return { text, isError: result.isError === true, nested: result.nestedCalls };
  }
  throw new Error("codemode produced no result");
}

describe("native MCP through codemode in a real session", () => {
  it("finds the server's tool, runs it, and records the nested calls for the card", async () => {
    const target = await run(
      'const hits = await searchTools("repeat text echo"); const out = await tools.mcp__fixture__echo({ text: "hi" }); return { hits: hits.map((hit) => hit.name), text: out.content[0].text };',
    );
    const result = codemodeResult(target);
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /mcp__fixture__echo/);
    assert.match(result.text, /echo: hi/);
    assert.deepEqual(
      (result.nested as { calls: { name: string; status: string }[] }).calls.map((call) => [call.name, call.status]),
      [["mcp__fixture__echo", "ok"]],
    );
    // The same record reaches the UI state.
    const part = projectPiMessages(target.messages as unknown[]).flatMap((message) => message.parts).find((item) => item.type === "tool");
    assert.deepEqual(part?.type === "tool" ? part.state.nestedCalls?.map((call) => call.name) : undefined, ["mcp__fixture__echo"]);
  }, 60_000);

  it("lets the script see a server-side error result without failing the whole script", async () => {
    const target = await run('const out = await tools.mcp__fixture__fail({}); return { isError: out.isError, text: out.content[0].text };');
    const result = codemodeResult(target);
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /fixture failure/);
  }, 60_000);
});
