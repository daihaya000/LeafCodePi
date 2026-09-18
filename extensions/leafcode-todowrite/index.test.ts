import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerTodowrite, { normalizeTodos, todowriteTestSeams } from "./index.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type TodoTool = {
  executionMode?: "sequential" | "parallel";
  execute: (...args: any[]) => Promise<{ details?: { error?: string; todos?: unknown[] } }>;
};

type FixtureOptions = {
  active?: boolean;
  branch?: unknown[];
  hasUI?: boolean;
};

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
  const writeTodos = (todos: unknown[]) => registeredTool.execute(
    "call-todowrite",
    { todos },
    undefined,
    undefined,
    ctx,
  );

  const settle = () => handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
  return { callTool, ctx, emit, settle, notify, sendMessage, writeTodos, tool: registeredTool };
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
