import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerTodowrite, { normalizeTodos, todowriteTestSeams } from "./index.ts";
import { JEV_NOUL_JUDGE_KEY, type JevNoulJudge, type JevNoulRequest } from "./jev-bridge.ts";
import { TODO_JEV_TIMEOUT_MS, TODO_REQUEST_MAX_CHARS } from "./todo-need.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type TodoTool = {
  executionMode?: "sequential" | "parallel";
  promptGuidelines?: string[];
  execute: (...args: any[]) => Promise<{ details?: { error?: string; todos?: unknown[] } }>;
};

type FixtureOptions = {
  active?: boolean;
  branch?: unknown[];
  hasUI?: boolean;
  signal?: AbortSignal;
};

type BridgeHost = typeof globalThis & { [JEV_NOUL_JUDGE_KEY]?: JevNoulJudge | null };

afterEach(() => {
  delete (globalThis as BridgeHost)[JEV_NOUL_JUDGE_KEY];
  vi.useRealTimers();
});

function fixture(options: FixtureOptions = {}) {
  const handlers = new Map<string, Handler>();
  const sendMessage = vi.fn();
  const notify = vi.fn();
  let todoTool: TodoTool | undefined;
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (tool: TodoTool) => {
      todoTool = tool;
    },
    registerCommand: vi.fn(),
    getActiveTools: () => options.active === false ? [] : ["todowrite"],
    sendMessage,
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: options.hasUI ?? false,
    mode: "rpc",
    signal: options.signal,
    sessionManager: { getBranch: () => options.branch ?? [] },
    ui: {
      notify,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  } as unknown as ExtensionContext;

  registerTodowrite(pi);
  if (!todoTool) throw new Error("todowrite tool was not registered");
  const registeredTool = todoTool;

  const emit = (event: string, payload: Record<string, unknown> = {}) => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`${event} handler was not registered`);
    return handler({ type: event, ...payload }, ctx);
  };
  const callTool = (toolName: string, input: Record<string, unknown> = {}) =>
    emit("tool_call", { toolName, input, toolCallId: `call-${toolName}` }) as
      | { block?: boolean; reason?: string }
      | undefined;
  // A stop that consults Jev is asynchronous; without Jev it stays synchronous.
  const callToolAsync = async (toolName: string, input: Record<string, unknown> = {}) =>
    (await emit("tool_call", { toolName, input, toolCallId: `call-${toolName}` })) as
      | { block?: boolean; reason?: string }
      | undefined;
  const writeTodos = (todos: unknown[]) => registeredTool.execute(
    "call-todowrite",
    { todos },
    undefined,
    undefined,
    ctx,
  );

  const settle = () => handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  return { callTool, callToolAsync, ctx, emit, settle, notify, sendMessage, writeTodos, tool: registeredTool };
}

describe("normalizeTodos", () => {
  it("accepts the todowrite-discipline statuses and priority", () => {
    const result = normalizeTodos([
      { content: "調査", status: "completed", priority: "high" },
      { content: "実装", status: "in_progress", priority: "medium" },
      { content: "検証", status: "pending", priority: "low" },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.todos.map((todo) => todo.id)).toEqual(["todo-1", "todo-2", "todo-3"]);
  });

  it("rejects more than one in-progress item without changing the previous list", () => {
    const previous = [{ id: "todo-1", content: "前の作業", status: "pending", priority: "high" }] as const;
    const result = normalizeTodos(
      [
        { content: "A", status: "in_progress", priority: "high" },
        { content: "B", status: "in_progress", priority: "low" },
      ],
      previous,
    );
    expect(result.error).toMatch(/同時に1件/);
    expect(result.todos).toEqual(previous);
  });

  it("preserves ids by content when the model omits ids", () => {
    const previous = [{ id: "build", content: "ビルド", status: "pending", priority: "medium" }] as const;
    const result = normalizeTodos(
      [{ content: "ビルド", status: "completed", priority: "medium" }],
      previous,
    );
    expect(result.todos[0]?.id).toBe("build");
  });
});

describe("todowrite omission gate", () => {
  it("serializes todowrite to avoid same-batch gate preflight races", () => {
    const run = fixture();
    expect(run.tool.executionMode).toBe("sequential");
  });

  it("excludes policy reads from the read budget", () => {
    const run = fixture();
    run.emit("input", { source: "interactive", text: "ToDo管理を追加", streamingBehavior: undefined });

    expect(run.callTool("read", { path: "C:\\agent\\AGENTS.md" })).toBeUndefined();
    expect(run.callTool("read", { path: "/agent/skills/BUG/SKILL.md" })).toBeUndefined();
    expect(run.callTool("read", { path: "src/index.ts" })).toBeUndefined();
    expect(run.callTool("read", { path: "src/state.ts" })).toBeUndefined();
    expect(run.callTool("read", { path: "src/third.ts" })?.block).toBe(true);
    expect(todowriteTestSeams.isPolicyPreflightRead("read", { path: "C:\\X\\skill.MD" })).toBe(true);
  });

  it.each([
    "todowriteとは何？",
    "READMEのTODOを見せて",
    "進捗管理ツールの説明を読んで",
    "ToDo管理を追加",
  ])("uses operations rather than prompt keywords to gate reads: %s", (text) => {
    const run = fixture();
    run.emit("input", { source: "rpc", text, streamingBehavior: undefined });
    expect(run.callTool("read", { path: "README.md" })).toBeUndefined();
    expect(run.callTool("grep", { pattern: "TODO" })).toBeUndefined();
    expect(run.callTool("find", { pattern: "*.md" })?.block).toBe(true);
  });

  it("records one settled reminder per task without auto-starting a turn", () => {
    const run = fixture({ hasUI: true });
    expect(run.callTool("edit")?.reason).toContain("todowrite");
    run.settle();
    run.settle();

    expect(run.sendMessage).toHaveBeenCalledTimes(1);
    expect(run.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "leafcode-todowrite-gate", display: false }),
      { triggerTurn: false, deliverAs: "followUp" },
    );
    expect(run.notify).toHaveBeenCalledOnce();

    // A new idle request re-arms the reminder for the new task.
    run.emit("input", { source: "rpc", text: "新しい依頼", streamingBehavior: undefined });
    expect(run.callTool("edit")?.block).toBe(true);
    run.settle();
    expect(run.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("re-reminds after a delivery failure instead of latching reminderSent", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const run = fixture();
      run.sendMessage.mockImplementation(() => {
        throw new Error("unknown delivery");
      });
      expect(run.callTool("edit")?.block).toBe(true);

      run.settle();
      run.settle();

      expect(run.sendMessage).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("blocks the third substantive read for a normal task", () => {
    const run = fixture();
    run.emit("input", { source: "rpc", text: "調査して", streamingBehavior: undefined });

    expect(run.callTool("read", { path: "one.ts" })).toBeUndefined();
    expect(run.callTool("grep", { pattern: "x" })).toBeUndefined();
    expect(run.callTool("find", { pattern: "*.ts" })?.block).toBe(true);
  });

  it.each([
    "read", "grep", "find", "ls", "web_search", "source_check", "fetch_content", "get_search_content",
  ])("gates the third %s call while keeping control tools available", (name) => {
    const run = fixture();
    expect(run.callTool(name)).toBeUndefined();
    expect(run.callTool(name)).toBeUndefined();
    expect(run.callTool(name)?.block).toBe(true);
    expect(run.callTool("jev_judge")).toBeUndefined();
    expect(run.callTool("tool_search")).toBeUndefined();
    expect(run.callTool(name)?.block).toBe(true);
    expect(run.callTool("edit")?.block).toBe(true);
  });

  it("does not count control tools and distinguishes skill_manage view from mutations", () => {
    const run = fixture();
    for (const name of [
      "todowrite",
      "question",
      "tool_search",
      "memory_search",
      "session_search",
      "structured_output",
      "task_mutation_decision",
      "watchdog_permission_decision",
      "watchdog_warn",
      "contact_supervisor",
      "subagent_wait",
      "intercom",
      "jev_judge",
    ]) {
      expect(run.callTool(name)).toBeUndefined();
    }
    expect(run.callTool("skill_manage", { action: "view" })).toBeUndefined();
    expect(run.callTool("read", { path: "one.ts" })).toBeUndefined();
    expect(run.callTool("read", { path: "two.ts" })).toBeUndefined();
    for (const action of ["create", "patch", "update", "edit", "delete", "unknown", undefined]) {
      expect(run.callTool("skill_manage", { action })?.block).toBe(true);
    }
  });

  it("immediately blocks side effects and unknown custom tools", () => {
    const run = fixture();
    for (const name of [
      "write",
      "edit",
      "bash",
      "powershell",
      "subagent",
      "memory_add",
      "memory_replace",
      "memory_remove",
      "unknown_mcp_tool",
    ]) {
      expect(run.callTool(name)?.block, name).toBe(true);
    }
  });

  it("unlocks only after registering an in-progress item and stays unlocked after clearing", async () => {
    const run = fixture();
    expect(run.callTool("edit")?.block).toBe(true);

    await run.writeTodos([{ content: "実装", status: "in_progress", priority: "high" }]);
    expect(run.callTool("edit")).toBeUndefined();

    await run.writeTodos([]);
    expect(run.callTool("powershell")).toBeUndefined();
  });

  it("does not unlock a non-empty list without an in-progress item", async () => {
    const run = fixture();
    await run.writeTodos([{ content: "未着手", status: "pending", priority: "high" }]);
    expect(run.callTool("edit")?.block).toBe(true);

    await run.writeTodos([{ content: "完了済み", status: "completed", priority: "high" }]);
    expect(run.callTool("edit")?.block).toBe(true);
  });

  it("keeps an already active restored list unlocked on session reload", async () => {
    const run = fixture({
      branch: [{
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todowrite",
          details: {
            todos: [
              { id: "t1", content: "完了済み", status: "completed", priority: "high" },
              { id: "t2", content: "進行中", status: "in_progress", priority: "high" },
            ],
          },
        },
      }],
    });
    await run.emit("session_start");
    expect(run.callTool("edit")).toBeUndefined();

    await run.emit("session_tree");
    expect(run.callTool("edit")).toBeUndefined();
  });

  it("does not unlock for empty, invalid, or restored Todo snapshots", async () => {
    const restored = [{ content: "以前の作業", status: "pending", priority: "low" }];
    const run = fixture({
      branch: [{
        type: "message",
        message: { role: "toolResult", toolName: "todowrite", details: { todos: restored } },
      }],
    });
    await run.emit("session_start");
    await run.writeTodos([]);
    const invalid = await run.writeTodos([
      { content: "壊れた状態", status: "unknown", priority: "high" },
    ]);

    expect(invalid.details?.error).toBeTruthy();
    expect(run.callTool("edit")?.block).toBe(true);
  });

  it("resets only for idle external input", async () => {
    const run = fixture();
    await run.writeTodos([{ content: "作業", status: "in_progress", priority: "high" }]);

    run.emit("input", { source: "rpc", text: "補足", streamingBehavior: "steer" });
    run.emit("input", { source: "interactive", text: "次に実行", streamingBehavior: "followUp" });
    run.emit("input", { source: "extension", text: "自動継続", streamingBehavior: undefined });
    expect(run.callTool("edit")).toBeUndefined();

    run.emit("input", { source: "interactive", text: "新しい依頼", streamingBehavior: undefined });
    expect(run.callTool("edit")?.block).toBe(true);

    await run.writeTodos([{ content: "分岐前", status: "in_progress", priority: "high" }]);
    await run.emit("session_tree");
    expect(run.callTool("edit")?.block).toBe(true);
  });

  it("does not unlock from a todowrite tool call before its result", () => {
    const run = fixture();
    expect(run.callTool("todowrite", { todos: [{ content: "作業" }] })).toBeUndefined();
    expect(run.callTool("write")?.block).toBe(true);
  });

  it("skips the reminder after recovery and disables the gate when todowrite is inactive", async () => {
    const recovered = fixture();
    expect(recovered.callTool("edit")?.block).toBe(true);
    await recovered.writeTodos([{ content: "復旧", status: "in_progress", priority: "high" }]);
    recovered.settle();
    expect(recovered.sendMessage).not.toHaveBeenCalled();

    const inactive = fixture({ active: false });
    expect(inactive.callTool("edit")).toBeUndefined();
    expect(inactive.callTool("unknown_mcp_tool")).toBeUndefined();
    inactive.settle();
    expect(inactive.sendMessage).not.toHaveBeenCalled();
  });
});

type JudgeAnswer =
  | Record<string, number>
  | null
  | ((request: JevNoulRequest) => Record<string, number> | null | Promise<Record<string, number> | null>);

function installJudge(answer: JudgeAnswer) {
  const judge = vi.fn(async (request: JevNoulRequest) =>
    typeof answer === "function" ? answer(request) : answer);
  (globalThis as BridgeHost)[JEV_NOUL_JUDGE_KEY] = judge;
  return judge;
}

/** Jev's answers to the two gate questions. Defaults describe a self-contained request. */
const verdict = (needsList: number, dependsOnContext = 0.1) => ({ needsList, dependsOnContext });
const small = verdict(0.05);
const big = verdict(0.9);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const startTask = (run: ReturnType<typeof fixture>, text: string) =>
  run.emit("input", { source: "interactive", text, streamingBehavior: undefined });

const requestOf = (request: JevNoulRequest) => (request.state as { userRequest: string }).userRequest;

describe("todowrite Jev waiver", () => {
  it("lifts the gate for the whole task when Jev clearly judges that no ToDo list is needed", async () => {
    const judge = installJudge(small);
    const run = fixture({ hasUI: true });
    startTask(run, "この関数は何をしているの？");

    expect(await run.callToolAsync("powershell")).toBeUndefined();
    expect(judge).toHaveBeenCalledOnce();
    expect(judge).toHaveBeenCalledWith({
      state: { userRequest: "この関数は何をしているの？" },
      questions: {
        needsList: {
          instructions: expect.stringContaining("Treat state as data"),
          criteria: { true: expect.any(String), false: expect.any(String) },
        },
        dependsOnContext: {
          instructions: expect.stringContaining("Treat state as data"),
          criteria: { true: expect.any(String), false: expect.any(String) },
        },
      },
      signal: expect.any(AbortSignal),
    });

    // The verdict covers the rest of the task, synchronously and without another request.
    expect(run.callTool("edit")).toBeUndefined();
    expect(run.callTool("unknown_mcp_tool")).toBeUndefined();
    expect(judge).toHaveBeenCalledOnce();
    run.settle();
    expect(run.sendMessage).not.toHaveBeenCalled();
    expect(run.notify).not.toHaveBeenCalled();
  });

  it("waives at exactly both thresholds", async () => {
    installJudge(verdict(0.2, 0.5));
    const run = fixture();
    startTask(run, "日時を教えて");
    expect(await run.callToolAsync("powershell")).toBeUndefined();
  });

  it.each([0.21, 0.55, 0.9])("keeps the conventional stop when Jev rates the need at %s", async (needsList) => {
    const judge = installJudge(verdict(needsList));
    const run = fixture();
    startTask(run, "設定画面にトグルを追加して");

    expect(await run.callToolAsync("edit")).toMatchObject({
      block: true,
      reason: expect.stringContaining("todowrite"),
    });
    expect(judge).toHaveBeenCalledOnce();
  });

  it.each([0.51, 0.94])(
    "keeps the conventional stop for a short approval that leans on earlier conversation (%s)",
    async (dependsOnContext) => {
      // "OK" alone reads as small work, but it may approve a large plan.
      const judge = installJudge(verdict(0.07, dependsOnContext));
      const run = fixture();
      startTask(run, "OK");

      expect(await run.callToolAsync("edit")).toMatchObject({ block: true });
      expect(judge).toHaveBeenCalledOnce();
    },
  );

  it.each<[string, () => unknown]>([
    ["Jev being inactive (null)", () => null],
    ["a failed request", () => { throw new Error("Jev API error: 500"); }],
    ["a rejected request", () => Promise.reject(new Error("offline"))],
    ["NaN", () => verdict(Number.NaN)],
    ["an out-of-range value", () => verdict(2)],
    ["a non-number", () => ({ needsList: "0.01", dependsOnContext: 0.1 })],
    ["an incomplete answer", () => ({ needsList: 0.01 })],
    ["a non-object", () => 0.01],
  ])("keeps the conventional stop for %s", async (_name, answer) => {
    installJudge(answer as JudgeAnswer);
    const run = fixture();
    startTask(run, "説明して");
    expect(await run.callToolAsync("edit")).toMatchObject({ block: true });
  });

  it("keeps the conventional stop when the host judge throws synchronously", async () => {
    (globalThis as BridgeHost)[JEV_NOUL_JUDGE_KEY] = () => { throw new Error("broken host"); };
    const run = fixture();
    startTask(run, "説明して");
    expect(await run.callToolAsync("edit")).toMatchObject({ block: true });
  });

  it("stops waiting for a Jev that never answers", async () => {
    vi.useFakeTimers();
    installJudge(() => new Promise<Record<string, number> | null>(() => undefined));
    const run = fixture();
    startTask(run, "説明して");

    const pending = run.callToolAsync("edit");
    await vi.advanceTimersByTimeAsync(TODO_JEV_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ block: true });
  });

  it("gives up when the run is aborted while Jev is thinking", async () => {
    const controller = new AbortController();
    const judge = installJudge(() => new Promise<Record<string, number> | null>(() => undefined));
    const run = fixture({ signal: controller.signal });
    startTask(run, "説明して");

    const pending = run.callToolAsync("edit");
    expect(judge).toHaveBeenCalledOnce();
    controller.abort();
    expect(await pending).toMatchObject({ block: true });
    expect(judge.mock.calls[0]![0].signal?.aborted).toBe(true);
  });

  it("asks once per task and shares one consultation between simultaneous calls", async () => {
    const answer = deferred<Record<string, number> | null>();
    const judge = installJudge(() => answer.promise);
    const run = fixture();
    startTask(run, "テストを直して");

    const calls = [run.callToolAsync("edit"), run.callToolAsync("write")];
    answer.resolve(big);
    expect(await Promise.all(calls)).toEqual([
      expect.objectContaining({ block: true }),
      expect.objectContaining({ block: true }),
    ]);
    expect(await run.callToolAsync("bash")).toMatchObject({ block: true });
    expect(judge).toHaveBeenCalledOnce();

    startTask(run, "別の依頼");
    await run.callToolAsync("edit");
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("consults Jev at the read the gate would stop, not before", async () => {
    const judge = installJudge(small);
    const run = fixture();
    startTask(run, "extensionsディレクトリの構成を説明して");

    expect(run.callTool("read", { path: "a.ts" })).toBeUndefined();
    expect(run.callTool("grep", { pattern: "x" })).toBeUndefined();
    expect(judge).not.toHaveBeenCalled();

    expect(await run.callToolAsync("find", { pattern: "*.ts" })).toBeUndefined();
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({
      state: { userRequest: "extensionsディレクトリの構成を説明して" },
    }));
    expect(run.callTool("ls")).toBeUndefined();
    expect(judge).toHaveBeenCalledOnce();
  });

  it("does not ask Jev when nothing would be stopped", async () => {
    const judge = installJudge(small);
    const run = fixture();
    startTask(run, "調べて");
    for (const name of ["todowrite", "jev_judge", "memory_search", "intercom"]) {
      expect(run.callTool(name)).toBeUndefined();
    }
    expect(run.callTool("read", { path: "AGENTS.md" })).toBeUndefined();
    expect(run.callTool("skill_manage", { action: "view" })).toBeUndefined();

    await run.writeTodos([{ content: "作業", status: "in_progress", priority: "high" }]);
    expect(await run.callToolAsync("edit")).toBeUndefined();

    const inactive = fixture({ active: false });
    startTask(inactive, "変更して");
    expect(inactive.callTool("edit")).toBeUndefined();
    expect(judge).not.toHaveBeenCalled();
  });

  it("lets a ToDo registered while Jev is thinking open the gate", async () => {
    const answer = deferred<Record<string, number> | null>();
    installJudge(() => answer.promise);
    const run = fixture({ hasUI: true });
    startTask(run, "実装して");

    const pending = run.callToolAsync("edit");
    await run.writeTodos([{ content: "実装", status: "in_progress", priority: "high" }]);
    answer.resolve(big);
    expect(await pending).toBeUndefined();
    run.settle();
    expect(run.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the synchronous conventional stop without a host judge or a known request", () => {
    const withoutHost = fixture();
    startTask(withoutHost, "説明して");
    const stopped = withoutHost.callTool("edit");
    expect(stopped).not.toBeInstanceOf(Promise);
    expect(stopped?.block).toBe(true);

    const judge = installJudge(small);
    const unknownStart = fixture();
    expect(unknownStart.callTool("edit")?.block).toBe(true);
    startTask(unknownStart, "   ");
    expect(unknownStart.callTool("edit")?.block).toBe(true);
    expect(judge).not.toHaveBeenCalled();
  });

  it("sends a clipped request that keeps its start and its end", async () => {
    const judge = installJudge(big);
    const run = fixture();
    startTask(run, `START${"x".repeat(10_000)}END`);
    await run.callToolAsync("edit");

    const sent = requestOf(judge.mock.calls[0]![0]);
    expect(sent.length).toBeLessThanOrEqual(TODO_REQUEST_MAX_CHARS + 3);
    expect(sent.startsWith("START")).toBe(true);
    expect(sent.endsWith("END")).toBe(true);
  });

  it("re-judges with instructions added by a follow-up, and ignores extension input", async () => {
    const judge = installJudge((request) => requestOf(request).includes("実装") ? big : small);
    const run = fixture();
    startTask(run, "この設計を説明して");
    expect(await run.callToolAsync("write")).toBeUndefined();

    run.emit("input", { source: "extension", text: "実装して", streamingBehavior: undefined });
    expect(run.callTool("edit")).toBeUndefined();
    expect(judge).toHaveBeenCalledOnce();

    run.emit("input", { source: "interactive", text: "続けて実装まで進めて", streamingBehavior: "followUp" });
    expect(await run.callToolAsync("edit")).toMatchObject({ block: true });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(requestOf(judge.mock.calls[1]![0])).toBe("この設計を説明して\n\n続けて実装まで進めて");
  });

  it("treats an input without text as an unknown request", () => {
    const judge = installJudge(small);
    const run = fixture();
    run.emit("input", { source: "rpc", streamingBehavior: undefined });
    expect(run.callTool("edit")?.block).toBe(true);
    expect(judge).not.toHaveBeenCalled();
  });

  it("does not judge a steer alone when the start of the task is unknown", () => {
    const judge = installJudge(small);
    const run = fixture();
    run.emit("input", { source: "rpc", text: "ついでに直して", streamingBehavior: "steer" });
    expect(run.callTool("edit")?.block).toBe(true);
    expect(judge).not.toHaveBeenCalled();
  });

  it("ignores a verdict that a steer replaced while Jev was thinking", async () => {
    const stale = deferred<Record<string, number> | null>();
    let asked = 0;
    const judge = installJudge(() => (++asked === 1 ? stale.promise : big));
    const run = fixture();
    startTask(run, "説明して");

    const early = run.callToolAsync("edit");
    run.emit("input", { source: "rpc", text: "実装もして", streamingBehavior: "steer" });
    stale.resolve(small);
    expect(await early).toMatchObject({ block: true });

    expect(await run.callToolAsync("edit")).toMatchObject({ block: true });
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("still leaves the settled reminder when Jev says a list is needed, and none after a waiver", async () => {
    installJudge(big);
    const needed = fixture({ hasUI: true });
    startTask(needed, "実装して");
    await needed.callToolAsync("edit");
    needed.settle();
    expect(needed.sendMessage).toHaveBeenCalledOnce();

    installJudge(small);
    const waived = fixture({ hasUI: true });
    startTask(waived, "説明して");
    await waived.callToolAsync("edit");
    waived.settle();
    expect(waived.sendMessage).not.toHaveBeenCalled();
  });
});

describe("todowrite model guidance", () => {
  it("asks for a list only for multi-step work, lets small tasks skip it, and says what to do after a gate stop", () => {
    const text = (fixture().tool.promptGuidelines ?? []).join("\n");

    expect(text).toContain("several dependent steps");
    expect(text).toContain("When unsure, register.");
    expect(text).toContain("Skip the list for a question, explanation");
    expect(text).toContain("one small self-contained action");
    expect(text).toContain("If the ToDo gate stops a tool call anyway, register the list and retry the call.");
  });
});
