import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  createAgentSession,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { captureNativeToolSearch, registerDeferredTools, type NativeToolSearch } from "./deferred-tools";
import { sessionToolSelection } from "./session-tool-selection";

let dir = "";
let session: AgentSession | undefined;
afterEach(() => {
  session?.dispose();
  session = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  dir = "";
});

const parameters = { type: "object", properties: {} } as never;
const stub = (name: string, description: string, exposure?: "deferred") => (api: ExtensionAPI) =>
  api.registerTool({
    name, label: name, description, parameters, ...(exposure ? { exposure } : {}),
    execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
  });

async function create(withNative: boolean, allTools = false) {
  dir = mkdtempSync(join(tmpdir(), "leafcode-tool-search-"));
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const nativeToolSearch: NativeToolSearch = {};
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      ...(withNative ? [captureNativeToolSearch(createToolSearchExtension(), nativeToolSearch)] : []),
      (api) => registerDeferredTools(api, undefined, withNative ? nativeToolSearch : undefined),
      stub("web_search", "Search the web"),
      ...(allTools ? [stub("future_ledger", "Summarize ledger balances", "deferred")] : []),
      // Native MCP registers its tools after a server connects, not while loading.
      (api) => {
        api.on("session_start", () => {
          stub("mcp__issues__list", "List open issues of a repository tracker", "deferred")(api);
          stub("mcp__proxy__web_search", "web_search through an MCP proxy", "deferred")(api);
        });
      },
    ],
  });
  await resourceLoader.reload();
  const registered = resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
  const picked = sessionToolSelection({ tools: ["read", "tool_search", "web_search"], allTools, dynamicMcpTools: !allTools, registered });
  const model = {
    id: "fixture", name: "Fixture", provider: "openai", api: "openai-completions", baseUrl: "https://example.invalid",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 1024,
  } as never;
  const created = await createAgentSession({
    cwd: dir, agentDir: dir, model, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir),
    ...("excludeTools" in picked ? { excludeTools: picked.excludeTools } : {}),
  });
  session = created.session;
  if ("initialActive" in picked) session.setActiveToolsByName(picked.preserveActive
    ? [...new Set([...session.getActiveToolNames(), ...picked.initialActive])]
    : picked.initialActive);
  await session.bindExtensions({});
  return { session, resourceLoader };
}

const search = async (target: AgentSession, query: string) => {
  const tool = target.agent.state.tools.find((candidate) => candidate.name === "tool_search");
  assert.ok(tool);
  const result = await tool.execute(`search-${query}`, { query }, new AbortController().signal);
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
};

describe("tool_search owner", () => {
  it("is wired into the harness for native MCP and every deferred-tool registration", () => {
    const source = readFileSync(new URL("./harness.ts", import.meta.url), "utf8");
    assert.match(source, /captureNativeToolSearch\(nativeMcpExtensionFactory\(\s*options\.cwd,[\s\S]*?\), nativeToolSearch, codeToolPolicy/);
    assert.equal(source.match(/registerDeferredTools\(api, [^)]*input\.nativeToolSearch\)/g)?.length, 3);
  });

  it("registers one tool_search and reports no conflict", async () => {
    const { resourceLoader } = await create(true);
    const loaded = resourceLoader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.filter((extension) => extension.tools.has("tool_search")).length, 1);
  }, 30_000);

  it("keeps loading optional tools by keyword", async () => {
    const { session: created } = await create(true);
    assert.match(await search(created, "web_search"), /web_search/);
  }, 30_000);

  it("delegates other queries to the SDK search, which loads MCP tools", async () => {
    const { session: created } = await create(true);
    assert.equal(created.getActiveToolNames().includes("mcp__issues__list"), false);
    const text = await search(created, "open issues tracker");
    assert.match(text, /mcp__issues__list/);
    assert.equal(created.getActiveToolNames().includes("mcp__issues__list"), true);
  }, 30_000);

  it("still finds an MCP tool when the query exactly names an optional tool", async () => {
    const { session: created } = await create(true);
    // "web_search" matches an optional tool exactly; a server may expose the same name.
    const text = await search(created, "web_search");
    assert.match(text, /web_search/);
    assert.match(text, /mcp__proxy__web_search/);
    assert.equal(created.getActiveToolNames().includes("mcp__proxy__web_search"), true);
  }, 30_000);

  it("still finds MCP tools when a generic keyword also matches an optional tool", async () => {
    const { session: created } = await create(true);
    const text = await search(created, "search open issues tracker");
    assert.match(text, /web_search/);
    assert.match(text, /mcp__issues__list/);
    assert.equal(created.getActiveToolNames().includes("mcp__issues__list"), true);
  }, 30_000);

  it("default discovers future deferred extension tools without the native MCP selection", async () => {
    const { session: created } = await create(true, true);
    assert.equal(created.getActiveToolNames().includes("future_ledger"), false);
    assert.match(await search(created, "ledger balances"), /future_ledger/);
    assert.ok(created.getActiveToolNames().includes("future_ledger"));
  }, 30_000);

  it("answers as before when no SDK search owner is installed", async () => {
    const { session: created } = await create(false);
    assert.match(await search(created, "open issues tracker"), /No optional tools matched/);
  }, 30_000);
});
