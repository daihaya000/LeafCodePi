import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, createCodemodeExtension, createToolSearchExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import registerTodowrite from "@extensions/leafcode-todowrite/index";
import { todoToolVisible } from "@extensions/leafcode-todowrite/visibility";
import { captureNativeToolSearch, registerDeferredTools, type NativeToolSearch } from "./deferred-tools";

let root = "";
let session: AgentSession | undefined;
afterEach(() => {
  session?.dispose();
  session = undefined;
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function declarations(context: TranscriptContext) {
  const tools = new Map<string, string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool.description);
  }
  return tools;
}
const work = [{ content: "Implementation", status: "in_progress", priority: "high" }];
const review = [{ content: "Implementation", status: "completed", priority: "high" }, { content: "Review", status: "in_progress", priority: "high" }];
const done = review.map((item) => ({ ...item, status: "completed" }));
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

async function fixture(options: { shell?: boolean; denyShell?: boolean } = {}) {
  root = mkdtempSync(join(tmpdir(), "leafcode-todo-visibility-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const native: NativeToolSearch = {};
  let runs = 0;
  let gitRuns = 0;
  const stubs: ExtensionFactory = (api) => {
    if (options.shell) {
      api.registerTool({ name: "powershell", label: "Test Shell", description: "Fake shell for permission pipeline tests",
        parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
        execute: async (_id, args) => { gitRuns++; return { content: [{ type: "text", text: args.command }], details: undefined }; },
      });
      if (options.denyShell) api.on("tool_call", (event) => event.toolName === "powershell" ? { block: true, reason: "Shell permission denied" } : undefined);
    }
    for (const [name, exposure] of [["future_mutation", "codemode"], ["future_deferred", "deferred"], ["memory_add", "direct"]] as const) api.registerTool({
      name, label: name, description: "Future mutation " + name, exposure,
      parameters: Type.Object({}),
      execute: async () => { runs++; return { content: [{ type: "text", text: name + " ran" }], details: undefined }; },
    });
  };
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    extensionFactories: [stubs,
      captureNativeToolSearch((api) => { createCodemodeExtension({ mode: "on", models: false })(api); createToolSearchExtension()(api); }, native),
      (api) => registerDeferredTools(api, undefined, native), registerTodowrite,
    ],
  });
  await loader.reload();
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const result = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root), modelRuntime, model: faux.getModel(), excludeTools: [] });
  session = result.session;
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  await session.bindExtensions({ onError: (error) => { throw Error(error.error); } });
  return { session, faux, runs: () => runs, gitRuns: () => gitRuns };
}

it("hides mutations on the actual first request, reveals only after a valid active list, then closes without revoking the loadout", async () => {
  const { session, faux, runs } = await fixture();
  const loadout = session.getActiveToolNames();
  faux.setResponses([
    (context) => {
      const tools = declarations(context);
      expect(tools.has("todowrite")).toBe(true);
      for (const name of ["edit", "write", "bash", "powershell", "memory_add"]) expect(tools.has(name)).toBe(false);
      expect(tools.has("read")).toBe(true);
      expect(tools.get("codemode")).not.toContain("future_mutation");
      return call("todowrite", { todos: [] });
    },
    (context) => {
      expect(declarations(context).has("edit")).toBe(false);
      return call("todowrite", { todos: work });
    },
    (context) => {
      expect(declarations(context).has("edit")).toBe(true);
      expect(declarations(context).get("codemode")).toContain("future_mutation");
      return call("codemode", { code: 'return await tools.future_mutation({});' });
    },
    () => call("todowrite", { todos: review }),
    () => call("todowrite", { todos: done }),
    (context) => {
      expect(declarations(context).has("edit")).toBe(false);
      expect(declarations(context).has("bash")).toBe(false);
      expect(declarations(context).has("powershell")).toBe(false);
      expect(declarations(context).has("git_finalize")).toBe(true);
      expect(declarations(context).get("codemode")).not.toContain("future_mutation");
      return fauxAssistantMessage("done");
    },
  ]);
  await session.prompt("Implement and review the change");
  expect(runs()).toBe(1);
  expect(session.getActiveToolNames()).toEqual(loadout);
  expect(session.messages.filter((message) => message.role === "toolResult").every((message) => !message.isError)).toBe(true);
  faux.setResponses([(context) => {
    expect(declarations(context).has("bash")).toBe(false); // a new task cannot inherit finalization
    expect(declarations(context).has("git_finalize")).toBe(false);
    expect(declarations(context).has("edit")).toBe(false);
    return fauxAssistantMessage("answer without work");
  }]);
  await session.prompt("Another request");
}, 20_000);

it("filters native/deferred discovery and the real codemode catalog before todo creation, including reload", async () => {
  const { session, faux, runs } = await fixture();
  for (const reload of [false, true]) {
    if (reload) await session.reload();
    faux.setResponses([
      call("tool_search", { query: "future_deferred" }),
      call("tool_search", { query: "memory_add" }),
      call("codemode", { code: 'return { future: "future_mutation" in tools, deferred: "future_deferred" in tools, memory: "memory_add" in tools, listed: ALL_TOOLS.some(t => t.name === "future_mutation"), matches: searchTools("future_mutation") };' }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Inspect tools without doing work");
    const results = session.messages.filter((message) => message.role === "toolResult");
    const last = results.at(-1);
    expect(last?.role === "toolResult" && last.isError).toBe(false);
    expect(JSON.stringify(last)).toContain('\\"future\\":false');
    expect(JSON.stringify(last)).toContain('\\"deferred\\":false');
    expect(JSON.stringify(last)).toContain('\\"memory\\":false');
    expect(JSON.stringify(last)).toContain('\\"listed\\":false');
    expect(runs()).toBe(0);
    expect(results.filter((message) => message.toolName === "tool_search").every((message) =>
      !JSON.stringify(message).includes("Loaded tools: memory_add") && !JSON.stringify(message).includes('"loaded":["future_deferred"]'))).toBe(true);
  }
}, 20_000);

it("keeps registration direct-only and restores an active snapshot on SDK reload", async () => {
  const { session, faux } = await fixture();
  faux.setResponses([
    call("codemode", { code: 'return { nestedTodo: "todowrite" in tools };' }),
    call("todowrite", { todos: work }),
    fauxAssistantMessage("paused"), fauxAssistantMessage("paused"), fauxAssistantMessage("paused"),
  ]);
  await session.prompt("Start work and pause with a persisted active list");
  const script = session.messages.find((entry) => entry.role === "toolResult" && entry.toolName === "codemode");
  expect(script?.role === "toolResult" && script.content.some((part) => part.type === "text" && part.text.includes('"nestedTodo":false'))).toBe(true);
  expect(todoToolVisible(session.sessionManager, "edit")).toBe(true);
  await session.reload();
  expect(todoToolVisible(session.sessionManager, "edit")).toBe(true);
});

it("retains the required review across SDK reload after an admitted mutation", async () => {
  const { session, faux } = await fixture();
  faux.setResponses([
    call("todowrite", { todos: work }),
    call("codemode", { code: "return await tools.future_mutation({});" }),
    fauxAssistantMessage("paused"), fauxAssistantMessage("paused"), fauxAssistantMessage("paused"),
  ]);
  await session.prompt("Implement a change and pause");
  await session.reload();
  // Extension input resumes the same task, rather than resetting it as a new external request.
  faux.setResponses([
    call("todowrite", { todos: work.map((todo) => ({ ...todo, status: "completed" })) }),
    fauxAssistantMessage("done"), fauxAssistantMessage("done"), fauxAssistantMessage("done"),
  ]);
  const before = session.messages.length;
  await session.prompt("Resume the pending task", { source: "extension" });
  expect(session.messages.slice(before).some((message) => message.role === "custom"
    && message.customType === "leafcode-todowrite-stop" && JSON.stringify(message).includes("レビュー"))).toBe(true);
});

it.each([false, true])("runs only scoped Git via the native shell hooks: denied=%s", async (denyShell) => {
  const { session, faux, gitRuns } = await fixture({ shell: true, denyShell });
  faux.setResponses([
    call("todowrite", { todos: work }), call("codemode", { code: "return await tools.future_mutation({});" }),
    call("todowrite", { todos: review }), call("todowrite", { todos: done }),
    (context) => {
      expect(declarations(context).has("powershell")).toBe(false);
      expect(declarations(context).has("git_finalize")).toBe(true);
      return call("git_finalize", { operation: "status" });
    },
    call("powershell", { command: "git status" }),
    fauxAssistantMessage("done"),
  ]);
  await session.prompt("Implement, review and finish Git");
  expect(gitRuns()).toBe(denyShell ? 0 : 1);
  const results = session.messages.filter((message) => message.role === "toolResult");
  expect(results.find((message) => message.toolName === "git_finalize")?.isError).toBe(denyShell);
  expect(results.find((message) => message.toolName === "powershell")?.isError).toBe(true);
});

it("does not apply a session\u0027s visibility policy to another session manager", async () => {
  const { session } = await fixture();
  expect(todoToolVisible(session.sessionManager, "edit")).toBe(false);
  expect(todoToolVisible({}, "edit")).toBe(true);
});
