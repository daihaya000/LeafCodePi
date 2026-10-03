import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, it } from "vitest";

/**
 * What codemode saves, measured on one fixed task: "which three of these files have the most TODOs?".
 * The model is scripted, so nothing here measures answer quality or provider cost; it measures what
 * reaches the model's context (tool results) and how many model requests the work needs.
 */
const FILE_COUNT = 30;
const LINES_PER_FILE = 60;

let root = "";
let session: AgentSession | undefined;
afterEach(() => {
  session?.dispose();
  session = undefined;
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  root = "";
});

function writeFixtureFiles(dir: string): { file: string; todos: number }[] {
  const expected: { file: string; todos: number }[] = [];
  for (let index = 0; index < FILE_COUNT; index += 1) {
    const todos = (index * 7) % 11;
    const lines = Array.from({ length: LINES_PER_FILE }, (_, line) =>
      line < todos ? `// TODO: item ${line} of file ${index} needs follow-up work` : `const value${line} = compute(${index}, ${line}); // regular code line`);
    writeFileSync(join(dir, `f${index}.txt`), lines.join("\n"), "utf8");
    expected.push({ file: `f${index}.txt`, todos });
  }
  // Ties keep file order, like the script's stable sort.
  return expected.sort((a, b) => b.todos - a.todos);
}

type Step = { calls: { name: string; args: { [key: string]: string } }[] };

async function run(steps: Step[]) {
  root = mkdtempSync(join(tmpdir(), "leafcode-codemode-effect-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const expected = writeFixtureFiles(root);
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ mode: "on", models: false })],
  });
  await resourceLoader.reload();
  const faux = fauxProvider();
  faux.setResponses([
    ...steps.map((step) =>
      fauxAssistantMessage(step.calls.map((call) => fauxToolCall(call.name, call.args)), { stopReason: "toolUse" })),
    fauxAssistantMessage("done"),
  ]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const created = await createAgentSession({
    cwd: root, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(root),
    modelRuntime, model: faux.getModel(), tools: ["read", "codemode"],
  });
  session = created.session;
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  await session.prompt("TODO が最も多い3ファイルを教えて");
  return { session, expected };
}

/** Characters the model would read: tool results, plus the size of the whole transcript at the end. */
function measure(target: AgentSession) {
  let toolResultChars = 0;
  let toolResults = 0;
  let transcriptChars = 0;
  let modelRequests = 0;
  // Each model request re-sends everything before it, so this is what the provider is asked to read.
  let cumulativeInputChars = 0;
  for (const message of target.messages) {
    const item = message as { role?: string; content?: unknown };
    const chars = typeof item.content === "string" ? item.content.length : JSON.stringify(item.content ?? "").length;
    if (item.role === "assistant") cumulativeInputChars += transcriptChars;
    transcriptChars += chars;
    if (item.role === "toolResult") {
      toolResults += 1;
      toolResultChars += Array.isArray(item.content)
        ? item.content.reduce((sum: number, part: { type?: string; text?: string }) => sum + (part.type === "text" ? part.text?.length ?? 0 : 0), 0)
        : 0;
    }
    if (item.role === "assistant") modelRequests += 1;
  }
  return { toolResults, toolResultChars, transcriptChars, modelRequests, cumulativeInputChars };
}

const SCRIPT = `
const files = Array.from({ length: ${FILE_COUNT} }, (_, index) => "f" + index + ".txt");
const texts = await Promise.all(files.map((path) => tools.read({ path })));
const counts = texts.map((text, index) => ({ file: files[index], todos: (text.match(/TODO/g) || []).length }));
counts.sort((a, b) => b.todos - a.todos);
return counts.slice(0, 3);
`;

describe("codemode effect on a fixed task", () => {
  it("keeps raw file contents out of the model's context", async () => {
    const readAll = Array.from({ length: FILE_COUNT }, (_, index) => ({ name: "read", args: { path: `f${index}.txt` } }));

    // A: one read per model request, the way a model usually works through a list.
    const sequential = await run(readAll.map((call) => ({ calls: [call] })));
    const a = measure(sequential.session);
    sequential.session.dispose();
    session = undefined;
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });

    // B: every read in one model request (the best case for plain tool calls).
    const parallel = await run([{ calls: readAll }]);
    const b = measure(parallel.session);
    parallel.session.dispose();
    session = undefined;
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });

    // C: one codemode script that reads, counts and returns only the answer.
    const scripted = await run([{ calls: [{ name: "codemode", args: { code: SCRIPT } }] }]);
    const c = measure(scripted.session);
    const answer = (scripted.session.messages as { role?: string; toolName?: string; content?: { text?: string }[] }[])
      .find((message) => message.role === "toolResult" && message.toolName === "codemode")
      ?.content?.map((part) => part.text ?? "").join("\n") ?? "";
    for (const row of scripted.expected.slice(0, 3)) {
      assert.ok(answer.includes(`"file":"${row.file}"`) && answer.includes(`"todos":${row.todos}`), `answer lacks ${row.file}: ${answer}`);
    }

    // The standing cost: codemode's own tool description is sent with every request while it is active.
    const descriptionChars = scripted.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description.length ?? 0;
    assert.ok(descriptionChars > 0);
    console.info(`codemode-effect ${JSON.stringify({ files: FILE_COUNT, sequential: a, parallel: b, codemode: c, codemodeDescriptionChars: descriptionChars })}`);
    assert.equal(a.toolResults, FILE_COUNT);
    assert.equal(c.toolResults, 1);
    assert.equal(a.modelRequests, FILE_COUNT + 1);
    assert.equal(c.modelRequests, 2);
    // The point of the feature: the script's answer is a small fraction of the raw reads.
    assert.ok(c.toolResultChars * 20 < b.toolResultChars, `${c.toolResultChars} vs ${b.toolResultChars}`);
    assert.ok(c.transcriptChars * 10 < b.transcriptChars, `${c.transcriptChars} vs ${b.transcriptChars}`);
  }, 60_000);
});
