import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerTodowrite, { normalizeTodos, todowriteTestSeams } from "./index.ts";
import { JEV_NOUL_JUDGE_KEY, type JevNoulJudge, type JevNoulRequest } from "./jev-bridge.ts";
import { TODO_JEV_TIMEOUT_MS, TODO_REQUEST_MAX_CHARS } from "./todo-need.ts";
import { classifyClosingShellCommand, isClosingShellCommand, isNonReviewShellCommand } from "./enforcement.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type TodoTool = {
  executionMode?: "sequential" | "parallel";
  exposure?: string;
  prepareLoadout?: (loadout: { declared: readonly { name: string }[] }) => { hiddenDeclarations: string[] };
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
  const refresh = vi.fn();
  const checkpoint = vi.fn();
  let todoTool: TodoTool | undefined;
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (tool: TodoTool) => {
      todoTool = tool;
    },
    registerCommand: vi.fn(),
    appendEntry: checkpoint,
    getActiveTools: () => options.active === false ? [] : ["todowrite"],
    setActiveTools: refresh,
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
  return { callTool, callToolAsync, ctx, emit, settle, notify, sendMessage, writeTodos, refresh, checkpoint, tool: registeredTool };
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

describe("todowrite review regressions", () => {
  it("writes review checkpoints only on audit transitions, not on repeated mutations", async () => {
    const run = fixture();
    await run.writeTodos([{ content: "Work", status: "in_progress", priority: "high" }]);
    for (let index = 0; index < 20; index++) run.callTool("edit");
    expect(run.checkpoint).toHaveBeenCalledTimes(2);
    await run.writeTodos([{ content: "Review", status: "in_progress", priority: "high" }]);
    expect(run.checkpoint).toHaveBeenCalledTimes(3);
    run.callTool("edit");
    expect(run.checkpoint).toHaveBeenCalledTimes(4);
    expect(run.checkpoint.mock.calls[3]![1]).not.toHaveProperty("reviewTodoId");
  });
  it("restores an active review marker so a reviewed task can finish after tree switching", async () => {
    const initial = fixture();
    await initial.writeTodos([{ content: "Work", status: "in_progress", priority: "high" }]);
    initial.callTool("edit");
    const result = await initial.writeTodos([{ content: "Review", status: "in_progress", priority: "high" }]);
    const branch = [
      { type: "message", message: { role: "toolResult", toolName: "todowrite", details: result.details } },
      ...initial.checkpoint.mock.calls.map(([customType, data]) => ({ type: "custom", customType, data })),
    ];
    const resumed = fixture({ branch });
    resumed.emit("session_tree");
    await resumed.writeTodos([{ content: "Review", status: "completed", priority: "high" }]);
    expect(resumed.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
  });
  it("keeps malformed audit checkpoints on the safe side instead of discarding required review", () => {
    const run = fixture({ branch: [
      { type: "message", message: { role: "toolResult", toolName: "todowrite", details: { todos: [] } } },
      { type: "custom", customType: "leafcode-todowrite-review-v1", data: { openedThisTask: false, reviewRequired: true } },
    ] });
    run.emit("session_start");
    expect(JSON.stringify(run.emit("agent_before_settle", { outcome: "completed" }))).toContain("レビュー");
  });
  it("stops an aborted waiting call even when a list opened while judgment was pending", async () => {
    const controller = new AbortController();
    installJudge(() => new Promise<Record<string, number> | null>(() => undefined));
    const run = fixture({ signal: controller.signal });
    startTask(run, "Implement a feature");
    const pending = run.callToolAsync("edit");
    await run.writeTodos([{ content: "Work", status: "in_progress", priority: "high" }]);
    controller.abort();
    expect(await pending).toMatchObject({ block: true });
  });
  it.each([true, false])("ignores failed restore snapshots and keeps the last successful active list: isError=%s", (isError) => {
    const active = [{ content: "Work", status: "in_progress", priority: "high" }];
    const run = fixture({ branch: [
      { type: "message", message: { role: "toolResult", toolName: "todowrite", details: { todos: active } } },
      { type: "message", message: { role: "toolResult", toolName: "todowrite", isError,
        details: { todos: [], ...(isError ? {} : { error: "Invalid update" }) } } },
    ] });
    run.emit("session_start");
    expect(run.callTool("edit")).toBeUndefined();
  });
  it("restores only the latest successful snapshot without normalizing older lists", () => {
    const oldMessage = vi.fn(() => { throw Error("Older snapshot must not be scanned"); });
    const branch = [
      { type: "message", get message() { return oldMessage(); } },
      { type: "message", message: { role: "toolResult", toolName: "todowrite", details: { todos: [] } } },
    ];
    const run = fixture({ branch });
    run.emit("session_start");
    expect(oldMessage).not.toHaveBeenCalled();
    expect(branch).toHaveLength(2);
    expect(run.callTool("edit")?.block).toBe(true);
  });
  it("rechecks an active list after a judgment wait instead of admitting work after completion", async () => {
    const answer = deferred<Record<string, number> | null>();
    installJudge(() => answer.promise);
    const run = fixture();
    startTask(run, "Implement a feature");
    const pending = run.callToolAsync("edit");
    await run.writeTodos([{ content: "Work", status: "in_progress", priority: "high" }]);
    await run.writeTodos([{ content: "Work", status: "completed", priority: "high" }]);
    answer.resolve(big);
    expect(await pending).toMatchObject({ block: true });
  });
  it("shares a judgment but enforces the mutation budget across simultaneous waiting calls", async () => {
    const answer = deferred<Record<string, number> | null>();
    const judge = installJudge(() => answer.promise);
    const run = fixture();
    startTask(run, "Fix one typo");
    const pending = Array.from({ length: 5 }, () => run.callToolAsync("edit"));
    answer.resolve(small);
    const results = await Promise.all(pending);
    expect(results.filter((result) => result === undefined)).toHaveLength(3);
    expect(results.filter((result) => result?.block)).toHaveLength(2);
    expect(judge).toHaveBeenCalledOnce();
    expect(await run.callToolAsync("edit")).toMatchObject({ block: true });
    expect(judge).toHaveBeenCalledOnce();
  });
  it.each([
    ["git status | sort | head -n 20", "bash", "confirmation"],
    ["git status | sort -u --reverse | head -n 20", "bash", "confirmation"],
    ["git status | sort '-ru'", "bash", "confirmation"],
    ["git status | Select-Object -First 20 | Out-String", "powershell", "confirmation"],
    ["git status && git diff || git log -1", "bash", "confirmation"],
    ["git fetch origin; git -C 'repo path' merge --no-edit origin/master | Out-String", "powershell", "merge"],
    ["git merge origin/master; git status", "bash", "merge"],
  ])("preserves safe closing pipelines and merge review: %s", (command, toolName, expected) => {
    expect(classifyClosingShellCommand(command, toolName)).toBe(expected);
    expect(isClosingShellCommand(command, toolName)).toBe(true);
    expect(isNonReviewShellCommand(command, toolName)).toBe(expected === "confirmation");
  });
  it.each([
    'git status | sort --output=source.ts', 'git status | sort -o source.ts',
    'git status | sort "--output=source.ts"', 'git status | sort -osource.ts',
    'git status | sort --compress-program=custom', 'git status | head-custom file',
    "git status | sort '-osource.ts'", "git status | sort '--compress-program=custom'",
    'git status | sort |', 'git status && || git diff',
    'git status | sort --out=source.ts', 'git status | sort --compress-prog=custom',
    'git status | sort -uo source.ts', "git status | sort '-uo' source.ts",
    'git push -qf', "git push '-qf'", 'git push -fq',
    'git status |', '| git status', 'git status ||', 'git status &&',
  ])("rejects output-filter side effects and malformed pipelines: %s", async (command) => {
    const run = fixture();
    await run.writeTodos([{ content: "Work", status: "in_progress", priority: "high" }]);
    await run.writeTodos([{ content: "Work", status: "completed", priority: "high" }]);
    expect(run.callTool("bash", { command })?.block).toBe(true);
  });
  it("rejects escaped unquoted POSIX flag fragments after completion", async () => {
    const run = fixture();
    await run.writeTodos([{ content: "Work", status: "in_progress", priority: "high" }]);
    await run.writeTodos([{ content: "Work", status: "completed", priority: "high" }]);
    expect(run.callTool("bash", { command: String.raw`git push --fo\rce` })?.block).toBe(true);
  });
  it.each([
    'git push "--force"', "git push '--force-with-lease=origin/master'", 'git push "--fo"rce',
    'git diff "--output=source.ts"', "git log --output=source.ts", "git diff --ext-diff", "git show --textconv",
    "git status | Where-Object { Remove-Item file.ts }", 'git push "$flags"', "git push $flags",
  ])("rejects hidden flags or executable constructs in the closing phase: %s", async (command) => {
    const run = fixture();
    await run.writeTodos([{ content: "Work", status: "in_progress", priority: "high" }]);
    await run.writeTodos([{ content: "Work", status: "completed", priority: "high" }]);
    expect(run.callTool("powershell", { command })?.block).toBe(true);
  });
  it("does not admit a stale tool call after the user switches tasks during a judgment", async () => {
    const answer = deferred<Record<string, number> | null>();
    const judge = installJudge(() => answer.promise);
    const run = fixture();
    startTask(run, "Fix one typo");
    const call = run.callToolAsync("edit");
    startTask(run, "Implement another feature");
    answer.resolve(small);
    expect(await call).toMatchObject({ block: true });
    judge.mockResolvedValue(big);
    expect(await run.callToolAsync("edit")).toMatchObject({ block: true });
  });
  it("reprojects declarations after a delayed read waiver opens the gate", async () => {
    installJudge(small);
    const run = fixture();
    startTask(run, "Explain the file");
    run.callTool("read"); run.callTool("read");
    const before = run.refresh.mock.calls.length;
    expect(await run.callToolAsync("read")).toBeUndefined();
    expect(run.refresh.mock.calls.length).toBeGreaterThan(before);
  });
  it("does not invalidate a completed review with the Git commit and confirmation phase", async () => {
    const run = fixture();
    await run.writeTodos([{ content: "Work", status: "in_progress", priority: "high" }]);
    run.callTool("edit");
    await run.writeTodos([{ content: "Review", status: "in_progress", priority: "high" }]);
    await run.writeTodos([{ content: "Review", status: "completed", priority: "high" }]);
    run.callTool("powershell", { command: "git add -- file.ts; git commit -m 'done'; git push origin master; git status --short" });
    expect(run.emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    run.callTool("powershell", { command: "git fetch origin; git merge --no-edit origin/master" });
    expect(JSON.stringify(run.emit("agent_before_settle", { outcome: "completed" }))).toContain("レビュー");
  });
  it("does not rebuild unchanged visibility on every admitted mutation", async () => {
    const run = fixture();
    await run.writeTodos([{ content: "Work", status: "in_progress", priority: "high" }]);
    const before = run.refresh.mock.calls.length;
    for (let i = 0; i < 20; i++) run.callTool("edit");
    expect(run.refresh.mock.calls.length).toBe(before);
  });
  it("keeps todo snapshots direct so reload and UI cannot lose nested registrations", () => {
    expect(fixture().tool.exposure).toBe("model-only");
  });
});

describe("todowrite model visibility", () => {
  const names = ["todowrite", "read", "edit", "powershell", "future_tool", "codemode"];
  const hidden = (run: ReturnType<typeof fixture>) => run.tool.prepareLoadout!({ declared: names.map((name) => ({ name })) }).hiddenDeclarations;
  it("keeps mutations hidden for empty, invalid and pending-only lists and unlocks only an active list", async () => {
    const run = fixture();
    expect(hidden(run)).toEqual(["edit", "powershell", "future_tool"]);
    await run.writeTodos([]);
    await run.writeTodos([{ content: "Work", status: "invalid", priority: "high" }]);
    await run.writeTodos([{ content: "Work", status: "pending", priority: "high" }]);
    expect(hidden(run)).toContain("edit");
    await run.writeTodos([{ content: "Work", status: "in_progress", priority: "high" }]);
    expect(hidden(run)).toEqual([]);
    await run.writeTodos([{ content: "Work", status: "completed", priority: "high" }]);
    expect(hidden(run)).toEqual(["edit", "future_tool"]);
  });
  it("removes ordinary read declarations after the two preflight reads", () => {
    const run = fixture();
    run.callTool("read", { path: "a.ts" });
    expect(hidden(run)).not.toContain("read");
    run.callTool("read", { path: "b.ts" });
    expect(hidden(run)).toContain("read");
    run.emit("input", { source: "interactive", text: "new request" });
    expect(hidden(run)).not.toContain("read");
  });
  it("decides the small-task waiver before declaring tools and reuses the verdict", async () => {
    const judge = installJudge(small);
    const run = fixture();
    startTask(run, "Fix one typo");
    await run.emit("before_agent_start");
    expect(hidden(run)).toEqual([]);
    expect(await run.callToolAsync("edit")).toBeUndefined();
    expect(judge).toHaveBeenCalledOnce();
  });
  it("keeps mutations hidden when preflight judgment is uncertain or fails", async () => {
    installJudge(null);
    const run = fixture();
    startTask(run, "Implement the feature");
    await run.emit("before_agent_start");
    expect(hidden(run)).toContain("edit");
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
      "show_image",
      "show_video",
      "show_audio",
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

  it("unlocks only after registering an in-progress item and closes again when the list is cleared", async () => {
    const run = fixture();
    expect(run.callTool("edit")?.block).toBe(true);

    await run.writeTodos([{ content: "実装", status: "in_progress", priority: "high" }]);
    expect(run.callTool("edit")).toBeUndefined();

    await run.writeTodos([]);
    expect(run.callTool("powershell")?.block).toBe(true);
    expect(run.callTool("read")).toBeUndefined();
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

describe("todowrite enforcement core", () => {
  const open = [{ content: "実装", status: "in_progress", priority: "high" }];
  const done = [{ content: "実装", status: "completed", priority: "high" }];
  const settleEvent = (run: ReturnType<typeof fixture>, outcome = "completed") =>
    run.emit("agent_before_settle", { outcome }) as { continue?: boolean; entries?: Array<{ content: string }> } | undefined;

  it("closes the gate when every item is completed, but still allows read-only work and the git closing phase", async () => {
    const run = fixture();
    await run.writeTodos(open);
    expect(run.callTool("edit")).toBeUndefined();
    await run.writeTodos(done);
    expect(run.callTool("edit")?.reason).toContain("全ToDoが完了済み");
    expect(run.callTool("read")).toBeUndefined();
    expect(run.callTool("powershell", { command: "git status --short" })).toBeUndefined();
    expect(run.callTool("powershell", { command: "git add -- a.ts; git commit -m 'x'" })).toBeUndefined();
    expect(run.callTool("powershell", { command: "git push --force" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git push --force-with-lease=origin/master" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git fetch --force=true" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git pull --rebase" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git merge --abort" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git status; Remove-Item a.ts" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git log $(rm x)" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git log --oneline -3 | Select-Object -First 1" })).toBeUndefined();
    expect(run.callTool("powershell", { command: "git status | Remove-Item a.ts" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git branch -D main" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "cd C:/repo; git status --short" })).toBeUndefined();
    expect(run.callTool("bash", { command: "cd /repo; git status --short" })).toBeUndefined();
    expect(run.callTool("bash", { command: "sl /repo; git status" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git commit -m 'a; b && c | d' -q" })).toBeUndefined();
    expect(run.callTool("powershell", { command: "git commit -m 'a''; Remove-Item x'" })).toBeUndefined();
    expect(run.callTool("powershell", { command: 'git commit -m "a; b && c | d"' })).toBeUndefined();
    expect(run.callTool("bash", { command: 'git commit -m "a; b && c | d"' })).toBeUndefined();
    expect(run.callTool("bash", { command: "git commit -m 'a; b && c | d'" })).toBeUndefined();
    expect(run.callTool("powershell", { command: "git fetch origin; git merge --no-edit origin/master" })).toBeUndefined();
    expect(run.callTool("powershell", { command: "git status --short && git diff --check" })).toBeUndefined();
    expect(run.callTool("powershell", { command: "git status && Remove-Item x" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "cd C:/repo; Remove-Item x" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git status > out.txt" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git commit -m \"$(Remove-Item x)\"" })?.block).toBe(true);
    expect(run.callTool("bash", { command: 'git commit -m "$(rm x)"' })?.block).toBe(true);
    expect(run.callTool("bash", { command: 'git commit -m "`rm x`"' })?.block).toBe(true);
    expect(run.callTool("bash", { command: "git status & Remove-Item x" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git status; Remove-Item x" })?.block).toBe(true);
    expect(run.callTool("powershell", { command: "git status; git commit -m 'unterminated" })?.block).toBe(true);
    expect(run.callTool("bash", { command: "npm test" })?.block).toBe(true);
    await run.writeTodos([...done, { content: "次の作業", status: "in_progress", priority: "high" }]);
    expect(run.callTool("edit")).toBeUndefined();
  });

  it("forces a continuation when the run settles with unfinished items, at most twice per task", async () => {
    const run = fixture();
    await run.writeTodos(open);
    for (let i = 0; i < 2; i += 1) {
      const result = settleEvent(run);
      expect(result?.continue).toBe(true);
      expect(result?.entries?.[0]?.content).toContain("未完了のToDo");
    }
    expect(settleEvent(run)).toBeUndefined();
    run.emit("input", { source: "interactive", text: "次", streamingBehavior: undefined });
    await run.writeTodos(open);
    expect(settleEvent(run)?.continue).toBe(true);
  });

  it("does not force a continuation for completed, aborted or inactive runs", async () => {
    const run = fixture();
    await run.writeTodos(open);
    expect(settleEvent(run, "aborted")).toBeUndefined();
    expect(settleEvent(run, "error")).toBeUndefined();
    const inactive = fixture({ active: false });
    expect(settleEvent(inactive)).toBeUndefined();
    const quiet = fixture();
    expect(settleEvent(quiet)).toBeUndefined();
  });

  it("requires a review started after the latest mutation before the run may settle", async () => {
    const run = fixture();
    const priorReview = { content: "レビュー・問題修正", status: "completed", priority: "high" };
    await run.writeTodos([priorReview, ...open]);
    run.callTool("edit");
    await run.writeTodos([priorReview, ...done]);
    expect(settleEvent(run)?.entries?.[0]?.content).toContain("レビュー");

    const cancelledReview = { ...priorReview, status: "cancelled" };
    await run.writeTodos([cancelledReview, ...done]);
    expect(settleEvent(run)?.entries?.[0]?.content).toContain("レビュー");

    const reviewInProgress = { ...priorReview, status: "in_progress" };
    await run.writeTodos([reviewInProgress, ...done]);
    await run.writeTodos([priorReview, ...done]);
    expect(settleEvent(run)).toBeUndefined();

    const shellRun = fixture();
    await shellRun.writeTodos(open);
    expect(shellRun.callTool("powershell", { command: "python modify.py" })).toBeUndefined();
    await shellRun.writeTodos(done);
    expect(settleEvent(shellRun)?.entries?.[0]?.content).toContain("レビュー");
    await shellRun.writeTodos([{ content: "レビュー", status: "in_progress", priority: "high" }, ...done]);
    await shellRun.writeTodos([{ content: "レビュー", status: "completed", priority: "high" }, ...done]);
    expect(settleEvent(shellRun)).toBeUndefined();

    const swappedReview = fixture();
    const oldReview = { content: "レビューA", status: "in_progress", priority: "high" };
    const nextReview = { content: "レビューB", status: "in_progress", priority: "high" };
    await swappedReview.writeTodos([
      oldReview,
      { content: "実装", status: "pending", priority: "high" },
    ]);
    swappedReview.callTool("edit");
    await swappedReview.writeTodos([
      { ...oldReview, status: "completed" },
      nextReview,
      ...done,
    ]);
    expect(settleEvent(swappedReview)?.entries?.[0]?.content).toContain("レビュー");
    swappedReview.callTool("edit");
    await swappedReview.writeTodos([
      { ...oldReview, status: "completed" },
      { ...nextReview, status: "completed" },
      ...done,
    ]);
    expect(settleEvent(swappedReview)?.entries?.[0]?.content).toContain("レビュー");
    await swappedReview.writeTodos([
      { ...oldReview, status: "completed" },
      nextReview,
      ...done,
    ]);
    await swappedReview.writeTodos([
      { ...oldReview, status: "completed" },
      { ...nextReview, status: "completed" },
      ...done,
    ]);
    expect(settleEvent(swappedReview)).toBeUndefined();
  });

  it("asks for a list when work was stopped and never registered", () => {
    const run = fixture();
    expect(run.callTool("edit")?.block).toBe(true);
    expect(settleEvent(run)?.entries?.[0]?.content).toContain("未起票");
  });

  it("expires a Jev waiver after the mutation budget and does not ask Jev again", async () => {
    const judge = installJudge(small);
    const run = fixture();
    startTask(run, "この関数は何をしているの？");
    for (let i = 0; i < 3; i += 1) expect(await run.callToolAsync("edit")).toBeUndefined();
    expect(judge).toHaveBeenCalledOnce();
    expect((await run.callToolAsync("edit"))?.block).toBe(true);
    expect((await run.callToolAsync("powershell"))?.block).toBe(true);
    expect(judge).toHaveBeenCalledOnce();
  });

  it("appends the live list to each request only while a list is being worked", async () => {
    const run = fixture();
    const messages = [{ role: "user", content: "依頼" }];
    expect(JSON.stringify(run.emit("context", { messages }))).toContain("ToDo開始ゲート");
    await run.writeTodos(open);
    const result = run.emit("context", { messages }) as { messages: Array<{ role: string; content: Array<{ text: string }> }> };
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]!.content[0]!.text).toContain("in_progress: 実装");
    await run.writeTodos(done);
    expect(run.emit("context", { messages })).toBeUndefined();
  });
});