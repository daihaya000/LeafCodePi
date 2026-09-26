import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bundledExtensionEntries } from "@/lib/extensions";
import { installToolResultCap, MAX_TOOL_RESULT_CHARS } from "./tool-result-cap";
import goalLoopExtension from "../../../../extensions/leafcode-goal-loop/index";
import loopGuardExtension, {
  callIdentity,
  STOP_REPEATS,
  WARN_REPEATS,
} from "../../../../extensions/leafcode-loop-guard/index";

// The 2026-09-25 incident: the same wrong path was probed for hours and always returned False.
const WRONG_PATH = "C:/work/_pdfexpress.py";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-loop-guard-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

type Probe = (path: string, call: number) => string | Promise<string>;
type Responses = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

const probeCall = (path: string) => fauxAssistantMessage([fauxToolCall("probe", { path })], { stopReason: "toolUse" });

/** Real SDK session: the loop guard sees the same tool_call/tool_result/message events as in the WebUI. */
async function createSession(probe: Probe, responses: Responses, extensions: ExtensionFactory[] = [], guardFirst = false) {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory();
  let executions = 0;
  const probeTool: ExtensionFactory = (api) => {
    api.registerTool({
      name: "probe",
      label: "probe",
      description: "Check whether a path exists.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => ({
        content: [{ type: "text", text: await probe(params.path, ++executions) }],
        details: undefined,
      }),
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
    // The bundled extensions resolve Pi types from the repo root; run them on the WebUI's SDK.
    extensionFactories: [probeTool, ...(guardFirst
      ? [loopGuardExtension as unknown as ExtensionFactory, ...extensions]
      : [...extensions, loopGuardExtension as unknown as ExtensionFactory])],
  });
  await resourceLoader.reload();
  const faux = fauxProvider();
  faux.setResponses(responses);
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
    tools: ["probe"],
  });
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  return { session, faux, executions: () => executions };
}

function probeResults(session: AgentSession): { text: string; isError: boolean }[] {
  return session.messages.flatMap((message) => {
    const result = message as { role?: string; toolName?: string; isError?: boolean; content?: unknown };
    if (result.role !== "toolResult" || result.toolName !== "probe" || !Array.isArray(result.content)) return [];
    const text = result.content
      .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text ?? "" : ""))
      .join("\n");
    return [{ text, isError: result.isError === true }];
  });
}

const warned = (result: { text: string }) => result.text.includes("[loop-guard]");

it("keeps the warning visible after the production output cap", async () => {
  const { session } = await createSession(
    () => "x".repeat(MAX_TOOL_RESULT_CHARS + 1000),
    [...Array.from({ length: WARN_REPEATS + 1 }, () => probeCall(WRONG_PATH)), fauxAssistantMessage("done")],
  );
  installToolResultCap(session.agent);
  try {
    await session.prompt("check");
    expect(warned(probeResults(session)[WARN_REPEATS])).toBe(true);
  } finally {
    session.dispose();
  }
});

it("does not mistake changing results that revisit an old value for no progress", async () => {
  const total = STOP_REPEATS + 4;
  const { session, executions } = await createSession(
    (_path, call) => String(call % 2),
    [...Array.from({ length: total }, () => probeCall(WRONG_PATH)), fauxAssistantMessage("done")],
  );
  try {
    await session.prompt("monitor state transitions");
    expect(executions()).toBe(total);
    expect(probeResults(session).some(warned)).toBe(false);
  } finally {
    session.dispose();
  }
});

it.each([false, true])("stops repeated denials regardless of extension load order (guardFirst=%s)", async (guardFirst) => {
  const deny: ExtensionFactory = (api) => {
    api.on("tool_call", () => ({ block: true, reason: "Denied by another extension" }));
  };
  const { session, faux, executions } = await createSession(
    () => "should not execute",
    [...Array.from({ length: STOP_REPEATS + 5 }, () => probeCall(WRONG_PATH)), fauxAssistantMessage("done")],
    [deny],
    guardFirst,
  );
  try {
    await session.prompt("check");
    expect(executions()).toBe(0);
    expect(probeResults(session).some(warned)).toBe(true);
    expect(faux.state.callCount).toBeLessThanOrEqual(STOP_REPEATS + 3);
  } finally {
    session.dispose();
  }
});

it("is discovered and loaded from the bundled extensions directory like the WebUI", async () => {
  // harness.ts passes bundledExtensionEntries() to the SDK as additionalExtensionPaths.
  vi.stubEnv("LEAFCODE_PI_EXTENSIONS_DIR", fileURLToPath(new URL("../../../../extensions", import.meta.url)));
  const entry = bundledExtensionEntries().find((candidate) => candidate.name === "leafcode-loop-guard");
  expect(entry).toBeDefined();
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [entry!.filePath],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  const guard = loaded.extensions.find((extension) => extension.path.includes("leafcode-loop-guard"));
  expect([...(guard?.handlers.keys() ?? [])]).toEqual(
    expect.arrayContaining(["agent_start", "message_start", "tool_call", "tool_result", "session_compact"]),
  );
});

it("identifies a call independently of argument key order", () => {
  expect(callIdentity("probe", { a: 1, b: { c: 2, d: 3 } })).toBe(callIdentity("probe", { b: { d: 3, c: 2 }, a: 1 }));
  expect(callIdentity("probe", { a: 1 })).not.toBe(callIdentity("other", { a: 1 }));
});

it("warns on repeated identical results, blocks the call, then ends the run", async () => {
  const { session, faux, executions } = await createSession(
    () => "False",
    Array.from({ length: STOP_REPEATS + 4 }, () => probeCall(WRONG_PATH)),
  );
  try {
    await session.prompt("find the pdf extractor");
    const results = probeResults(session);
    expect(executions()).toBe(STOP_REPEATS + 1);
    expect(results).toHaveLength(STOP_REPEATS + 3);
    expect(results.slice(0, WARN_REPEATS).some(warned)).toBe(false);
    expect(results.slice(WARN_REPEATS, STOP_REPEATS + 1).every(warned)).toBe(true);
    const [blocked, ended] = results.slice(STOP_REPEATS + 1);
    expect(blocked).toMatchObject({ isError: true });
    expect(blocked.text).toContain("この呼び出しを止めました");
    expect(ended).toMatchObject({ isError: true });
    expect(ended.text).toContain("この実行を終了しました");
    // terminate: the model is not asked again after the final stop.
    expect(faux.state.callCount).toBe(STOP_REPEATS + 3);
    expect(faux.getPendingResponseCount()).toBe(1);
  } finally {
    session.dispose();
  }
});

it("clears the previous stop after the model makes fresh progress", async () => {
  const attempts = STOP_REPEATS + 2;
  const { session, faux } = await createSession(
    (path) => path,
    [
      ...Array.from({ length: attempts }, () => probeCall(WRONG_PATH)),
      ...Array.from({ length: attempts }, () => probeCall("C:/work/new-path")),
      fauxAssistantMessage("reported to user"),
    ],
  );
  try {
    await session.prompt("check");
    const blocked = probeResults(session).filter((result) => result.isError);
    expect(blocked).toHaveLength(2);
    expect(blocked.every((result) => result.text.includes("この呼び出しを止めました"))).toBe(true);
    expect(faux.getPendingResponseCount()).toBe(0);
  } finally {
    session.dispose();
  }
});

it("detects a short cycle of already-seen results", async () => {
  const paths = Array.from({ length: STOP_REPEATS + 6 }, (_, index) => (index % 2 ? "C:/work" : WRONG_PATH));
  const { session, executions } = await createSession(
    (path) => (path === WRONG_PATH ? "False" : "_pdfextract.py"),
    paths.map(probeCall),
  );
  try {
    await session.prompt("find the pdf extractor");
    // Two first-time results, then STOP_REPEATS repeats of known results.
    expect(executions()).toBe(STOP_REPEATS + 2);
    expect(probeResults(session).at(-1)?.text).toContain("この実行を終了しました");
  } finally {
    session.dispose();
  }
});

it("terminates duplicate calls in parallel batches without counting a result twice", async () => {
  const { session, executions, faux } = await createSession(
    () => "False",
    Array.from({ length: STOP_REPEATS + 4 }, () => fauxAssistantMessage([
      fauxToolCall("probe", { path: WRONG_PATH }),
      fauxToolCall("probe", { path: WRONG_PATH }),
    ], { stopReason: "toolUse" })),
  );
  try {
    await session.prompt("check twice");
    expect(executions()).toBe(STOP_REPEATS + 2);
    expect(faux.state.callCount).toBe(7);
    expect(probeResults(session).at(-1)?.text).toContain("この実行を終了しました");
  } finally {
    session.dispose();
  }
});

it("does not count polling whose result changes", async () => {
  const { session, executions } = await createSession(
    (_path, call) => `pending ${call}`,
    [...Array.from({ length: STOP_REPEATS + 4 }, () => probeCall("C:/work/build.log")), fauxAssistantMessage("done")],
  );
  try {
    await session.prompt("wait for the build");
    expect(executions()).toBe(STOP_REPEATS + 4);
    expect(probeResults(session).some(warned)).toBe(false);
  } finally {
    session.dispose();
  }
});

it("starts over when the user steers mid-run", async () => {
  const current: { session?: AgentSession } = {};
  const total = STOP_REPEATS + 4;
  const { session, executions } = await createSession(
    async (_path, call) => {
      if (call === 5) await current.session?.steer("もう一度確認して");
      return "False";
    },
    [...Array.from({ length: total }, () => probeCall(WRONG_PATH)), fauxAssistantMessage("done")],
  );
  current.session = session;
  try {
    await session.prompt("find the pdf extractor");
    const results = probeResults(session);
    expect(executions()).toBe(total);
    expect(results.some((result) => result.isError)).toBe(false);
    expect(warned(results[4])).toBe(true);
    // The steering message is new input: the next identical result is not a repeat.
    expect(warned(results[5])).toBe(false);
  } finally {
    session.dispose();
  }
});

it("does not accumulate identical checks across Goal Loop turns", async () => {
  const perTurn = STOP_REPEATS - 2;
  const turns = 2;
  // Each Goal Loop turn runs the same check perTurn times and then reports progress.
  const respond = (context: { messages: readonly { role: string }[] }) => {
    let results = 0;
    for (let index = context.messages.length - 1; index >= 0; index -= 1) {
      const role = context.messages[index].role;
      if (role === "user") break;
      if (role === "toolResult") results += 1;
    }
    return results < perTurn
      ? probeCall(WRONG_PATH)
      : fauxAssistantMessage(JSON.stringify({ status: "progress", summary: "checked", next: "check again" }));
  };
  const { session, executions } = await createSession(
    () => "False",
    Array.from({ length: turns * (perTurn + 1) }, () => respond),
    [goalLoopExtension as unknown as ExtensionFactory],
  );
  const state = () => JSON.parse(readFileSync(
    join(root, "data", "goals-loop", `${session.sessionManager.getSessionId()}.json`),
    "utf8",
  ));
  try {
    const goal = { goal: "Check the extractor", maxTurns: turns, cooldownSeconds: 0, forceFullRun: false };
    await session.prompt(`/goal-start ${Buffer.from(JSON.stringify(goal)).toString("base64url")}`);
    await vi.waitFor(
      () => expect(state()).toMatchObject({ status: "paused", pauseReason: "turn_limit", turnCount: turns }),
      // Below vitest's 5s test timeout so a regression fails with the actual state.
      { timeout: 4_000, interval: 50 },
    );
    await session.agent.waitForIdle();
    const results = probeResults(session);
    // Without the per-turn reset this many identical checks would be blocked.
    expect(turns * perTurn).toBeGreaterThan(STOP_REPEATS + 1);
    expect(executions()).toBe(turns * perTurn);
    expect(results.some((result) => result.isError)).toBe(false);
    expect(warned(results[perTurn])).toBe(false);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
