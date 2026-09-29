import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledExtensionEntries } from "@/lib/extensions";
import todowriteExtension from "../../../../extensions/leafcode-todowrite/index";
import { createJevNoulJudge, registerJevNoulJudge } from "./jev-noul-judge";
import type { TypeSafeResponse } from "./typesafe-system-one";

const PROMPT = "この関数は何をしているの？";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-todowrite-jev-"));
});
afterEach(() => {
  registerJevNoulJudge(null);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** Jev's answers to the gate's two questions. Defaults describe a small, self-contained request. */
const answers = (needsList: number, dependsOnContext = 0.1): TypeSafeResponse => ({
  model: "jev-1.13.0",
  answers: {
    needsList: { type: "noul", noul: needsList },
    dependsOnContext: { type: "noul", noul: dependsOnContext },
  },
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** Publishes the judge the way the harness does, with Jev's answers and usability faked. */
function publishJudge(options: { needsList?: number; dependsOnContext?: number; usable?: boolean } = {}) {
  const evaluate = vi.fn(async () => answers(options.needsList ?? 0.05, options.dependsOnContext));
  registerJevNoulJudge(createJevNoulJudge({ isUsable: async () => options.usable ?? true, evaluate }));
  return evaluate;
}

/**
 * Real SDK session: the gate sees the same input / tool_call events as in the WebUI.
 * "path" loads the extension from the bundled extensions directory (jiti), as the WebUI does.
 */
async function createSession(load: "factory" | "path" = "factory") {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory();
  let executions = 0;
  const workTool: ExtensionFactory = (api) => {
    // Not a read tool, so the gate stops it until a ToDo list exists.
    api.registerTool({
      name: "probe_write",
      label: "probe_write",
      description: "Pretend to change something.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "changed" }], details: undefined };
      },
    });
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(load === "path"
      ? { additionalExtensionPaths: [bundledTodowritePath()], extensionFactories: [workTool] }
      : { extensionFactories: [workTool, todowriteExtension as unknown as ExtensionFactory] }),
  });
  await resourceLoader.reload();
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("probe_write", { path: "a.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime,
    model: faux.getModel(),
    tools: ["probe_write", "todowrite"],
  });
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  return { session, executions: () => executions };
}

function bundledTodowritePath(): string {
  // harness.ts passes bundledExtensionEntries() to the SDK as additionalExtensionPaths.
  vi.stubEnv("LEAFCODE_PI_EXTENSIONS_DIR", fileURLToPath(new URL("../../../../extensions", import.meta.url)));
  const entry = bundledExtensionEntries().find((candidate) => candidate.name === "leafcode-todowrite");
  if (!entry) throw new Error("leafcode-todowrite is not discovered as a bundled extension");
  return entry.filePath;
}

function workResults(session: AgentSession): { text: string; isError: boolean }[] {
  return session.messages.flatMap((message) => {
    const result = message as { role?: string; toolName?: string; isError?: boolean; content?: unknown };
    if (result.role !== "toolResult" || result.toolName !== "probe_write" || !Array.isArray(result.content)) return [];
    const text = result.content
      .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : ""))
      .join("\n");
    return [{ text, isError: result.isError === true }];
  });
}

describe("ToDo gate with Jev through a real SDK session", () => {
  it("lets the work through when Jev clearly judges that no ToDo list is needed", async () => {
    const evaluate = publishJudge({ needsList: 0.05 });
    const { session, executions } = await createSession();
    try {
      await session.prompt(PROMPT);

      expect(executions()).toBe(1);
      expect(workResults(session)).toEqual([{ text: "changed", isError: false }]);
      // The user's own prompt, and nothing else, is what Jev judged: as data, in one request.
      expect(evaluate).toHaveBeenCalledOnce();
      const [request] = evaluate.mock.calls[0] as unknown as [
        { state: unknown; questions: Record<string, { type: string }> },
      ];
      expect(request.state).toEqual({ userRequest: PROMPT });
      expect(Object.entries(request.questions).map(([id, question]) => [id, question.type])).toEqual([
        ["needsList", "noul"],
        ["dependsOnContext", "noul"],
      ]);
    } finally {
      session.dispose();
    }
  });

  it("works when loaded from the bundled extensions directory like the WebUI", async () => {
    const evaluate = publishJudge({ needsList: 0.05 });
    const { session, executions } = await createSession("path");
    try {
      await session.prompt(PROMPT);

      expect(executions()).toBe(1);
      expect(evaluate).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
    }
  });

  it.each([
    ["Jev says the task needs a list", "設定画面にトグルを追加して", { needsList: 0.9 }, true],
    ["Jev is unsure", PROMPT, { needsList: 0.55 }, true],
    // "OK" alone sounds small, but it may approve a large plan.
    ["the request leans on earlier conversation", "OK", { needsList: 0.07, dependsOnContext: 0.94 }, true],
    ["no Jev model is usable", PROMPT, { usable: false }, false],
  ])("keeps the conventional stop when %s", async (_name, prompt, options, asked) => {
    const evaluate = publishJudge(options);
    const { session, executions } = await createSession();
    try {
      await session.prompt(prompt);

      expect(executions()).toBe(0);
      const [stopped] = workResults(session);
      expect(stopped).toMatchObject({ isError: true });
      expect(stopped!.text).toContain("todowrite");
      expect(evaluate).toHaveBeenCalledTimes(asked ? 1 : 0);
    } finally {
      session.dispose();
    }
  });

  it("keeps the conventional stop when the host published no judge", async () => {
    const { session, executions } = await createSession();
    try {
      await session.prompt(PROMPT);

      expect(executions()).toBe(0);
      expect(workResults(session)[0]).toMatchObject({ isError: true });
    } finally {
      session.dispose();
    }
  });

  it("delivers the model guidance through the system prompt built from the bundled extension", async () => {
    const { session } = await createSession("path");
    try {
      // The gate no longer forces a list for small tasks, so the model must be told the same rule.
      expect(session.systemPrompt).toContain("several dependent steps");
      expect(session.systemPrompt).toContain("Skip the list for a question, explanation");
      expect(session.systemPrompt).toContain("If the ToDo gate stops a tool call anyway");
    } finally {
      session.dispose();
    }
  });
});
