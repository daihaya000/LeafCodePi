import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotDto, RoomDto, RoomMessage, TaskSummary, UiMessage } from "@/lib/types";

const store = vi.hoisted(() => ({ root: "", bots: new Map<string, BotDto>(), tasks: new Map<string, TaskSummary>(), projects: [{ id: "project", name: "Project", archived: false }], rooms: new Map<string, RoomDto>(), abortTask: vi.fn(async (id: string) => store.tasks.get(id)) }));
vi.mock("@/lib/paths", () => ({ dataDir: () => store.root }));
vi.mock("@/lib/pi/harness", () => ({ abortTask: store.abortTask }));
vi.mock("@/lib/bots", () => ({
  getBot: (id: string) => store.bots.get(id),
  patchBot: (id: string, patch: Partial<BotDto>) => { const bot = store.bots.get(id); if (bot) Object.assign(bot, patch); return bot; },
}));
vi.mock("@/lib/rooms", () => ({
  getRoom: (id: string) => store.rooms.get(id),
  roomBotTaskId: (roomId: string, botId: string) => `bot:${botId}:room:${roomId}`,
  updateRoomMessage: (roomId: string, messageId: string, patch: Partial<RoomMessage> | ((message: RoomMessage) => Partial<RoomMessage>)) => {
    const message = store.rooms.get(roomId)?.messages.find((item) => item.id === messageId);
    if (message) Object.assign(message, typeof patch === "function" ? patch(message) : patch);
    return message;
  },
}));
vi.mock("@/lib/store", () => ({
  getTask: (id: string) => store.tasks.get(id),
  getProject: (id: string) => store.projects.find((project) => project.id === id),
  listProjects: () => store.projects.filter((project) => !project.archived),
}));
import { BOT_CODE_RESULT, BOT_CODE_TOOL, botCodeReportText, cancelRoomCodeRequests, createBotCodeRelay, hasBotCodeReport, isBotCodeOriginTask, listBotCodeRequests, MAX_AUTO_CODE_CHAIN, pendingRoomCodeRequestForRoom, pendingRoomCodeRequestForTurn, roomForCodeOrigin, runUserBotCodeRequest, stopBotCodeRequest, stopBotCodeRequestForTask, type CodeRequest } from "./bot-code-relay";

type Dependencies = Parameters<typeof createBotCodeRelay>[0];
let relay: ReturnType<typeof createBotCodeRelay>;
let deps: Dependencies;
let messages: UiMessage[];
function task(id: string, extra: Partial<TaskSummary> = {}): TaskSummary { return { id, status: "idle", projectId: "project", ...extra } as TaskSummary; }
function answer(id: string, text: string): UiMessage { return { id, role: "assistant", createdAt: Date.now(), parts: [{ id: `${id}-text`, type: "text", text }] }; }
function record(): CodeRequest {
  const directory = join(store.root, "bot-code-requests");
  const file = readdirSync(directory).find((name) => name.endsWith(".json"))!;
  return JSON.parse(readFileSync(join(directory, file), "utf8"));
}
function records(): CodeRequest[] {
  const directory = join(store.root, "bot-code-requests");
  return readdirSync(directory).filter((name) => name.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")) as CodeRequest);
}
function launch(call = "start-1") { return relay.run("bot:one", call, { action: "start", projectId: "project", prompt: "Fix the parser; run its test" }, "session"); }
function roomSetup() {
  store.bots.set("two", { id: "two", name: "Two", enabled: true, permissionMode: "allow" } as BotDto);
  store.tasks.set("bot:one:room:room-1", task("bot:one:room:room-1", { kind: "bot", botId: "one" }));
  store.tasks.set("bot:two:room:room-1", task("bot:two:room:room-1", { kind: "bot", botId: "two" }));
  const conversation = { requestId: "user-1", participantIds: ["one", "two"], turn: 1, maxTurns: 6 };
  store.rooms.set("room-1", {
    id: "room-1", name: "Room", members: ["one", "two"], createdAt: "", updatedAt: "",
    messages: [
      { id: "user-1", role: "user", text: "残作業も進めて", createdAt: 1 },
      { id: "turn-1", role: "assistant", botId: "one", text: "", status: "working", createdAt: 2, conversation },
    ],
  });
  return { conversation };
}
function roomLaunch(call = "room-start") {
  return relay.run("bot:one:room:room-1", call, { action: "start", projectId: "project", prompt: "Fix the parser" }, "session");
}

beforeEach(() => {
  store.root = mkdtempSync(join(tmpdir(), "bot-code-relay-"));
  store.bots.clear(); store.tasks.clear(); store.rooms.clear(); store.projects[0].archived = false; store.abortTask.mockClear();
  store.bots.set("one", { id: "one", enabled: true, permissionMode: "allow", model: "model", codeSessionTaskId: null } as BotDto);
  store.tasks.set("bot:one", task("bot:one", { kind: "bot", botId: "one" }));
  messages = [];
  deps = {
    create: vi.fn(async (input) => {
      const code = task("code", { status: "working" }); store.tasks.set(code.id, code);
      input.beforePrompt(code);
      return code;
    }),
    prompt: vi.fn(async (id) => { const code = store.tasks.get(id)!; code.status = "working"; return code; }),
    abort: vi.fn(async (id) => { const code = store.tasks.get(id)!; code.status = "idle"; code.manualAbortedAssistantId = ""; return code; }),
    approve: vi.fn(async () => true),
    isBusy: (id) => store.tasks.get(id)?.status === "working",
    goalLoop: vi.fn(() => null),
    messages: vi.fn(async () => messages),
    deliver: vi.fn(async () => true),
    afterDelivery: vi.fn(async () => undefined),
  };
  relay = createBotCodeRelay(deps);
});
afterEach(() => { relay.dispose(); rmSync(store.root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("Bot-only tool schemas stay llama.cpp-safe", () => {
  // llama.cpp compiles tool schemas into GBNF; a nested string with maxLength >= 2000
  // produces unparseable grammar and every request 400s with
  // "Failed to initialize samplers: failed to parse grammar" (ggml-org/llama.cpp#25746).
  // Top-level string properties are capped by llama.cpp itself, nested ones are not.
  function collect(node: unknown, nested: boolean): number[] {
    if (!node || typeof node !== "object") return [];
    const schema = node as Record<string, unknown>;
    const hits: number[] = [];
    if (nested && schema.type === "string" && typeof schema.maxLength === "number" && schema.maxLength >= 2_000) {
      hits.push(schema.maxLength);
    }
    const children = [
      ...Object.values((schema.properties as Record<string, unknown> | undefined) ?? {}),
      ...(schema.items ? [schema.items] : []),
      ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
      ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ];
    for (const child of children) hits.push(...collect(child, true));
    return hits;
  }

  /** Root properties are top-level for llama.cpp; anything below them is nested. */
  function nestedMaxLengths(parameters: unknown): number[] {
    const properties = (parameters as { properties?: Record<string, unknown> } | null)?.properties ?? {};
    return Object.values(properties).flatMap((property) => collect(property, false));
  }

  function toolSchemas(): { name: string; parameters: unknown }[] {
    const tools: { name: string; parameters: unknown }[] = [];
    const pi = { registerTool: (tool: { name: string; parameters: unknown }) => { tools.push(tool); } };
    relay.register("bot:one")(pi as never);
    return tools;
  }

  it("keeps nested string maxLength below the llama.cpp grammar limit", () => {
    const tools = toolSchemas();
    expect(tools.map((tool) => tool.name)).toContain(BOT_CODE_TOOL);
    for (const tool of tools) {
      expect({ tool: tool.name, nested: nestedMaxLengths(tool.parameters) }).toEqual({ tool: tool.name, nested: [] });
    }
  });
});

describe("Bot ⇄ Code relay", () => {
  it("ignores a corrupted request file instead of throwing", async () => {
    const dir = join(store.root, "bot-code-requests");
    mkdirSync(dir, { recursive: true });
    // sha256 形式のファイル名だが JSON として壊れたレコードを置く
    writeFileSync(join(dir, `${'f'.repeat(64)}.json`), "{broken");

    expect(() => pendingRoomCodeRequestForRoom("room-1")).not.toThrow();
    expect(listBotCodeRequests("one")).toEqual([]);

    // 破損ファイルが残っていても新規依頼と tick は動き続ける
    await launch();
    await expect(relay.tick()).resolves.not.toThrow();
    expect(listBotCodeRequests("one")).toHaveLength(1);
  });

  it("persists the link before execution, returns immediately, then reports exactly once", async () => {
    const result = await launch();
    expect(result).toMatchObject({ taskId: "code", state: "running" });
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "ask", model: "auto", botId: "one" }));
    expect(store.bots.get("one")?.codeSessionTaskId).toBe("code");
    expect(relay.originForCode("code")).toBe("bot:one");
    expect(record().state).toBe("running");
    await relay.tick(); expect(deps.deliver).not.toHaveBeenCalled();
    messages = [answer("final", "Changed parser. Tests passed.")];
    store.tasks.get("code")!.status = "idle";
    await relay.tick(); await relay.tick();
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ originTaskId: "bot:one", result: expect.stringContaining("Tests passed") }));
    expect(record().state).toBe("delivered");
    expect(relay.originForCode("code")).toBeNull();
    await launch(); expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it("recovers the durable outbox after restart and waits while the Bot is busy", async () => {
    await launch(); relay.dispose();
    relay = createBotCodeRelay(deps);
    store.tasks.get("code")!.status = "error";
    store.tasks.get("code")!.error = "Worker restarted";
    store.tasks.get("bot:one")!.status = "working";
    await relay.tick();
    expect(record().state).toBe("ready"); expect(deps.deliver).not.toHaveBeenCalled();
    store.tasks.get("bot:one")!.status = "idle";
    await relay.tick();
    expect(deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ result: expect.stringContaining("Worker restarted") }));
    relay.dispose(); relay = createBotCodeRelay(deps);
    await relay.tick(); expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("does not treat a linked task as a crashed launch while it is still working", async () => {
    await launch();
    const request = record();
    request.state = "starting";
    writeFileSync(join(store.root, "bot-code-requests", `${request.id}.json`), JSON.stringify(request), "utf8");

    await relay.tick();

    expect(record().state).toBe("starting");
    expect(deps.deliver).not.toHaveBeenCalled();

    store.tasks.get("code")!.status = "idle";
    await relay.tick();
    expect(record().state).toBe("delivered");
  });

  it("stops a Code task when its Room request is reverted", async () => {
    roomSetup();
    await roomLaunch();

    expect(await cancelRoomCodeRequests("room-1", "user-1")).toBe(1);
    expect(record().state).toBe("cancelled");
    expect(store.abortTask).toHaveBeenCalledWith("code");
  });

  it("does not abort the predecessor for a queued Room prompt", async () => {
    roomSetup();
    await roomLaunch();
    const first = record();
    const queued: CodeRequest = { ...first, id: "f".repeat(64), state: "queued", action: "prompt", queuedAt: Date.now() + 1 };
    writeFileSync(join(store.root, "bot-code-requests", `${queued.id}.json`), JSON.stringify(queued), "utf8");

    expect(await cancelRoomCodeRequests("room-1", "user-1")).toBe(2);
    expect(store.abortTask).toHaveBeenCalledTimes(1);
    expect(records().every((request) => request.state === "cancelled")).toBe(true);
  });

  it("skips approval for a Bot with standing Code approval", async () => {
    store.bots.get("one")!.codeAutoApprove = true;
    const result = await relay.run("bot:one", "always-allow", { action: "start", prompt: "一般的な調査をして" }, "session");

    expect(result).toMatchObject({ taskId: "code", state: "running" });
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it("starts a new Code task without a project", async () => {
    const result = await relay.run("bot:one", "no-project", { action: "start", prompt: "一般的な調査をして" }, "session");

    expect(result).toMatchObject({ taskId: "code", state: "running" });
    expect(deps.approve).toHaveBeenCalledWith("session", expect.stringContaining("プロジェクト: プロジェクトなし"));
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
    expect(store.bots.get("one")?.codeSessionTaskId).toBe("code");
  });

  it("reports a Goal Loop run by the loop verdict, not by its last message", async () => {
    const goalLoop = { acceptance: ["テストが通ること"], maxTurns: 3, cooldownSeconds: 0, forceFullRun: false };
    await relay.run("bot:one", "loop-done", { action: "start", projectId: "project", prompt: "目標を達成して", goalLoop }, "session");
    store.tasks.get("code")!.status = "idle";
    messages = [answer("turn", "修正しました")];
    vi.mocked(deps.goalLoop).mockReturnValue({ status: "completed", turnCount: 2, maxTurns: 3 } as never);
    await relay.tick();

    expect(record().result).toContain("目標達成");
    expect(JSON.parse(record().result!).goalLoop).toMatchObject({ status: "completed", turnCount: 2 });
  });

  it("delivers the acceptance criteria and the loop's own evidence with the result", async () => {
    const goalLoop = { acceptance: ["テストが通ること"], maxTurns: 3, cooldownSeconds: 0, forceFullRun: false };
    await relay.run("bot:one", "loop-evidence", { action: "start", projectId: "project", prompt: "目標を達成して", goalLoop }, "session");
    store.tasks.get("code")!.status = "idle";
    messages = [answer("turn", "完了しました")];
    vi.mocked(deps.goalLoop).mockReturnValue({
      status: "blocked", turnCount: 2, maxTurns: 3, acceptance: ["テストが通ること"],
      blockedReason: "依存のインストール権限がありません", summary: "テストは未実行", evidence: "npm test 未実行".repeat(400), rejectedClaims: 2,
    } as never);
    await relay.tick();

    const payload = JSON.parse(record().result!) as { outcome: string; goalLoop: Record<string, unknown> };
    expect(payload.outcome).toBe("阻害要因あり");
    expect(payload.goalLoop).toMatchObject({ acceptance: ["テストが通ること"], blockedReason: "依存のインストール権限がありません", summary: "テストは未実行", rejectedClaims: 2 });
    // Loop notes are bounded so one delivery cannot flood the Bot conversation.
    expect((payload.goalLoop.evidence as string).length).toBe(2_000);
    // The Bot screen reads the same verdict without opening Code.
    expect(listBotCodeRequests("one")[0]).toMatchObject({
      outcome: "阻害要因あり",
      goalLoop: { status: "blocked", acceptance: ["テストが通ること"], rejectedClaims: 2 },
    });
  });

  it("does not report a turn-limit pause as a finished run", async () => {
    const goalLoop = { acceptance: [], maxTurns: 2, cooldownSeconds: 0, forceFullRun: false };
    await relay.run("bot:one", "loop-limit", { action: "start", projectId: "project", prompt: "長い作業", goalLoop }, "session");
    store.tasks.get("code")!.status = "idle";
    messages = [answer("turn", "途中まで進めました")];
    vi.mocked(deps.goalLoop).mockReturnValue({ status: "paused", pauseReason: "turn_limit", turnCount: 2, maxTurns: 2 } as never);
    await relay.tick();

    expect(record().result).toContain("ターン上限で中断");
    expect(record().result).not.toContain("実行終了");
  });

  it("keeps an ordinary follow-up out of an earlier loop verdict", async () => {
    await launch();
    store.tasks.get("code")!.status = "idle";
    messages = [answer("plain", "通常の応答")];
    vi.mocked(deps.goalLoop).mockReturnValue({ status: "completed", turnCount: 1, maxTurns: 1 } as never);
    await relay.tick();

    expect(record().result).toContain("実行終了");
    expect(deps.goalLoop).not.toHaveBeenCalled();
  });

  it("passes Goal Loop settings to a new Code task", async () => {
    const goalLoop = {
      acceptance: ["テストが通ること"],
      maxTurns: 3,
      cooldownSeconds: 5,
      forceFullRun: true,
    };

    await relay.run("bot:one", "goal-loop", {
      action: "start",
      projectId: "project",
      prompt: "修正して",
      goalLoop,
    }, "session");

    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ goalLoop }));
    expect(record().goalLoop).toEqual(goalLoop);
    expect(deps.approve).toHaveBeenCalledWith("session", expect.stringContaining("Goal Loop"));
  });

  it("continues the same session and excludes its previous answer", async () => {
    await launch(); messages = [answer("old", "Old answer")]; store.tasks.get("code")!.status = "idle";
    await relay.tick();
    await relay.run("bot:one", "follow-1", { action: "prompt", prompt: "Add an edge case" }, "session");
    expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.prompt).toHaveBeenCalledWith("code", "Add an edge case", expect.any(String));
    store.tasks.get("code")!.status = "idle";
    await relay.tick();
    const delivered = vi.mocked(deps.deliver).mock.calls.at(-1)![0];
    expect(delivered.result).not.toContain("Old answer");
    expect(delivered.result).toContain("結果を取得できませんでした");
  });

  it("does not report an earlier answer when the recorded baseline left the transcript", async () => {
    await launch(); store.tasks.get("code")!.status = "idle";
    await relay.tick();
    messages = [answer("old", "Old answer")];
    await relay.run("bot:one", "follow-lost-baseline", { action: "prompt", prompt: "Add an edge case" }, "session");
    // A revert/reset removed the baseline entry while the follow-up produced no answer of its own.
    messages = [answer("renamed", "Old answer")];
    store.tasks.get("code")!.status = "idle";
    await relay.tick();

    const delivered = vi.mocked(deps.deliver).mock.calls.at(-1)![0];
    expect(delivered.result).not.toContain("Old answer");
    expect(delivered.result).toContain("結果を取得できませんでした");
  });

  it("tracks a follow-up the user sends from the Bot screen so its result still reports back", async () => {
    const code = task("code", { status: "idle" });
    store.tasks.set(code.id, code);

    await runUserBotCodeRequest(
      "one",
      { prompt: "続けて直して", projectId: "project", followUp: { codeTaskId: "code", baseline: "previous" } },
      async (codeRequestId, link) => {
        expect(codeRequestId).toMatch(/^[a-f0-9]{64}$/);
        link(code.id);
        return code;
      },
    );

    expect(record()).toMatchObject({ action: "prompt", codeTaskId: "code", baseline: "previous", state: "running", originTaskId: "bot:one" });
  });

  it("captures the delegated turn before a directly queued Code turn replaces its output", async () => {
    await launch(); messages = [answer("delegated", "Requested fix completed")];
    const id = relay.requestIdForCode("code")!;
    await relay.complete(id);
    messages = [answer("direct", "Unrelated direct Code response")];
    await relay.tick();
    expect(record().result).toContain("Requested fix completed");
    expect(record().result).not.toContain("Unrelated");
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it("preserves pending results on delivery failure and retries with backoff", async () => {
    await launch(); store.tasks.get("code")!.status = "idle";
    vi.mocked(deps.deliver).mockResolvedValueOnce(false);
    await relay.tick(); await relay.tick();
    expect(record().state).toBe("ready"); expect(deps.deliver).toHaveBeenCalledTimes(1);
    const pending = record(); pending.nextAttemptAt = 0;
    writeFileSync(join(store.root, "bot-code-requests", `${pending.id}.json`), JSON.stringify(pending), "utf8");
    await relay.tick(); expect(record().state).toBe("delivered");
  });

  it("rejects missing approval, aborted calls, invalid projects, and non-Bot callers", async () => {
    vi.mocked(deps.approve).mockResolvedValueOnce(false);
    await expect(launch()).rejects.toThrow("not approved");
    const controller = new AbortController(); controller.abort();
    await expect(relay.run("bot:one", "cancel", { action: "start", projectId: "project", prompt: "do" }, "session", controller.signal)).rejects.toThrow("cancelled");
    await expect(relay.run("bot:one", "bad", { action: "start", projectId: "../../path", prompt: "do" }, "session")).rejects.toThrow("registered project");
    await expect(relay.run("code", "bad", { action: "projects" }, "session")).rejects.toThrow("1:1 Bot");
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("revalidates project and Bot permissions after user approval", async () => {
    vi.mocked(deps.approve).mockImplementationOnce(async () => { store.projects[0].archived = true; return true; });
    await expect(launch()).rejects.toThrow("unavailable");
    store.projects[0].archived = false;
    vi.mocked(deps.approve).mockImplementationOnce(async () => { store.bots.get("one")!.permissionMode = "deny"; return true; });
    await expect(launch()).rejects.toThrow("does not permit");
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("runs multiple one-to-one Code requests without mixing their receipts", async () => {
    let nextCode = 0;
    vi.mocked(deps.create).mockImplementation(async (input) => {
      const code = task(`code-${++nextCode}`, { status: "working" });
      store.tasks.set(code.id, code);
      input.beforePrompt(code);
      return code;
    });
    await Promise.all([launch("start-1"), launch("start-2")]);
    expect(deps.create).toHaveBeenCalledTimes(2);
    expect(records()).toHaveLength(2);
    expect(records().every((request) => request.originTaskId === "bot:one")).toBe(true);
    // Attention routing must see every waiting session, not only the one that started first.
    expect(relay.codeTasksForOrigin("bot:one").sort()).toEqual(["code-1", "code-2"]);
    store.bots.get("one")!.enabled = false;
    expect(relay.codeTasksForOrigin("bot:one")).toEqual([]);
  });

  it("reports a stop as interrupted rather than successful", async () => {
    await launch(); messages = [answer("partial", "Partial work")];
    await relay.run("bot:one", "abort", { action: "abort" }, "session");
    await relay.tick();
    expect(record().result).toContain("停止・中断");
  });

  it("keeps a user stop final: reports it as stopped and refuses an autonomous continuation", async () => {
    await launch();
    const stopped = await stopBotCodeRequest("one", record().id);

    expect(stopped).toMatchObject({ state: "running", codeTaskId: "code" });
    expect(record().stoppedByUser).toBe(true);
    // The route aborts the Code task after the record is marked.
    await deps.abort("code");
    vi.mocked(deps.deliver).mockImplementationOnce(async () => {
      await expect(relay.run("bot:one", "after-stop", { action: "start", projectId: "project", prompt: "続きをやる" }, "session")).rejects.toThrow("user stopped");
      return true;
    });
    await relay.tick();

    expect(record().result).toContain("ユーザーが停止");
    expect(listBotCodeRequests("one")[0].outcome).toBe("ユーザーが停止");
    expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it("reports a Code session the user started from the Bot screen", async () => {
    const started = await runUserBotCodeRequest("one", { prompt: "画面を直して", projectId: "project" }, async (codeRequestId, link) => {
      expect(codeRequestId).toMatch(/^[a-f0-9]{64}$/);
      const code = task("code", { status: "working" });
      store.tasks.set(code.id, code);
      link(code.id);
      return code;
    });

    expect(started.id).toBe("code");
    expect(record()).toMatchObject({ botId: "one", originTaskId: "bot:one", codeTaskId: "code", state: "running", action: "start" });
    store.tasks.get("code")!.status = "idle";
    messages = [answer("done", "画面を修正しました")];
    await relay.tick();

    expect(deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ originTaskId: "bot:one", result: expect.stringContaining("画面を修正しました") }));
  });

  it("keeps a failed user-started launch as a reportable outcome", async () => {
    await expect(runUserBotCodeRequest("one", { prompt: "起動できない", projectId: "project" }, async () => {
      throw new Error("モデルが見つかりません");
    })).rejects.toThrow("モデルが見つかりません");

    expect(record()).toMatchObject({ state: "ready", codeTaskId: null });
    expect(record().result).toContain("失敗");
  });

  it("rejects a stop that does not belong to the Bot", async () => {
    await launch();

    expect(await stopBotCodeRequest("other", record().id)).toBeUndefined();
    expect(await stopBotCodeRequest("one", "not-a-request-id")).toBeUndefined();
    expect(await stopBotCodeRequestForTask("other", "code")).toBeUndefined();
    expect(await stopBotCodeRequestForTask("one", "unknown-code")).toBeUndefined();
    expect(record().stoppedByUser).toBeUndefined();
  });

  it("makes a stop by Code task id final too", async () => {
    await launch();

    expect(await stopBotCodeRequestForTask("one", "code")).toMatchObject({ state: "running", codeTaskId: "code" });
    expect(record().stoppedByUser).toBe(true);
    await deps.abort("code");
    await relay.tick();
    expect(record().result).toContain("ユーザーが停止");
  });

  it("keeps attention attached to the originating Bot even after manual unlink", async () => {
    await launch(); store.bots.get("one")!.codeSessionTaskId = null;
    expect(relay.codeForOrigin("bot:one")).toBe("code");
    expect(relay.originForCode("code")).toBe("bot:one");
    expect(relay.codeForOrigin("bot:other")).toBeNull();
    store.bots.get("one")!.enabled = false;
    await relay.tick(); expect(record().state).toBe("cancelled");
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("allows one autonomous follow-up Code request while reporting a result", async () => {
    await launch(); store.tasks.get("code")!.status = "idle";
    vi.mocked(deps.deliver).mockImplementationOnce(async () => {
      await expect(relay.run("bot:one", "follow-up", { action: "start", projectId: "project", prompt: "残っている作業を続けて" }, "session")).resolves.toMatchObject({ taskId: "code", state: "running" });
      await expect(relay.run("bot:one", "second-follow-up", { action: "start", projectId: "project", prompt: "さらに別の作業" }, "session")).rejects.toThrow("Only one follow-up Code request");
      return true;
    });
    await relay.tick();
    expect(deps.create).toHaveBeenCalledTimes(2);
    expect(records()).toHaveLength(2);
  });

  it("counts each autonomous continuation on the new request", async () => {
    await launch(); store.tasks.get("code")!.status = "idle";
    vi.mocked(deps.deliver).mockImplementationOnce(async () => {
      await relay.run("bot:one", "chain-1", { action: "start", projectId: "project", prompt: "残りを進める" }, "session");
      return true;
    });
    await relay.tick();

    expect(records().find((request) => request.prompt === "残りを進める")?.autoChain).toBe(1);
    // A later user instruction is not a continuation, so it starts a fresh count.
    await relay.run("bot:one", "user-asked", { action: "start", projectId: "project", prompt: "別の作業" }, "session");
    expect(records().find((request) => request.prompt === "別の作業")?.autoChain).toBeUndefined();
  });

  it("refuses an autonomous continuation past the cumulative limit", async () => {
    await launch();
    const first = record();
    first.autoChain = MAX_AUTO_CODE_CHAIN;
    writeFileSync(join(store.root, "bot-code-requests", `${first.id}.json`), JSON.stringify(first), "utf8");
    store.tasks.get("code")!.status = "idle";
    vi.mocked(deps.deliver).mockImplementationOnce(async () => {
      await expect(relay.run("bot:one", "too-deep", { action: "start", projectId: "project", prompt: "さらに続ける" }, "session")).rejects.toThrow("cumulative limit");
      return true;
    });
    await relay.tick();

    expect(deps.create).toHaveBeenCalledTimes(1);
    expect(records()).toHaveLength(1);
  });

  it("registers a callable tool bound to the originating task, not a model-provided Bot id", async () => {
    const tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
    relay.register("bot:one")({ registerTool: (tool: never) => tools.push(tool) } as never);
    expect(tools[0].name).toBe("code_session");
    const result = await tools[0].execute("list", { action: "projects" }, undefined, undefined, { sessionManager: { getSessionId: () => "session" } });
    expect(result).toMatchObject({ details: { projects: [{ id: null, name: "プロジェクトなし" }, { id: "project", name: "Project" }] } });
  });
});

describe("Room ⇄ Code delegation", () => {
  it("binds the request to the executing Room turn and mirrors its state on that message", async () => {
    const { conversation } = roomSetup();
    const result = await roomLaunch();

    expect(result).toMatchObject({ taskId: "code", state: "running" });
    expect(record().room).toEqual({ id: "room-1", responseId: "turn-1", conversation });
    // The Room owns its Code link; the 1:1 session pointer must stay untouched.
    expect(store.bots.get("one")?.codeSessionTaskId).toBeNull();
    const turn = store.rooms.get("room-1")!.messages.at(-1)!;
    expect(turn).toMatchObject({ codeRequestId: record().id, codeTaskId: "code", codeState: "running" });
    expect(relay.originForCode("code")).toBe("bot:one:room:room-1");
    expect(pendingRoomCodeRequestForRoom("room-1")?.id).toBe(record().id);
    expect(pendingRoomCodeRequestForTurn("room-1", conversation.requestId)?.id).toBe(record().id);
    // A different request must not be paused by this record.
    expect(pendingRoomCodeRequestForTurn("room-1", "user-2")).toBeUndefined();
    expect(roomForCodeOrigin(store.tasks.get("bot:one:room:room-1"))?.id).toBe("room-1");
    expect(isBotCodeOriginTask(store.tasks.get("bot:one:room:room-1"))).toBe(true);
    expect(isBotCodeOriginTask({ id: "bot:one:room:missing", kind: "bot", botId: "one" })).toBe(false);
  });

  it("continues the Room's own Code session rather than the Bot's 1:1 session", async () => {
    roomSetup();
    store.bots.get("one")!.codeSessionTaskId = "other-code";
    store.tasks.set("other-code", task("other-code"));
    await roomLaunch();
    store.tasks.get("code")!.status = "idle";
    await relay.tick();
    expect(await relay.run("bot:one:room:room-1", "room-status", { action: "status" }, "session")).toMatchObject({ task: { id: "code" } });
    await relay.run("bot:one:room:room-1", "room-follow", { action: "prompt", prompt: "Add a test" }, "session");
    expect(deps.prompt).toHaveBeenCalledWith("code", "Add a test", expect.any(String));
  });

  it.each(["superseded", "removed", "finished"])("refuses a %s Room turn instead of executing detached work", async (change) => {
    roomSetup();
    const room = store.rooms.get("room-1")!;
    if (change === "superseded") room.messages.push({ id: "user-2", role: "user", text: "別の依頼", createdAt: 3 });
    if (change === "removed") room.members = ["two"];
    if (change === "finished") room.messages.at(-1)!.status = "done";
    await expect(roomLaunch()).rejects.toThrow(change === "removed" ? "Room member" : "no longer active");
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("skips the approval prompt only when the Room carries standing approval", async () => {
    roomSetup();
    store.rooms.get("room-1")!.codeAutoApprove = true;
    await roomLaunch();
    expect(deps.approve).not.toHaveBeenCalled();
    expect(record().state).toBe("running");

    // The 1:1 path still asks independently and can run alongside the Room request.
    await launch("one-to-one");
    expect(deps.approve).toHaveBeenCalledTimes(1);
    expect(deps.create).toHaveBeenCalledTimes(2);
  });

  it("still asks for approval when the Room has not granted it", async () => {
    roomSetup();
    vi.mocked(deps.approve).mockResolvedValueOnce(false);
    await expect(roomLaunch()).rejects.toThrow("not approved");
    expect(deps.approve).toHaveBeenCalledTimes(1);
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("starts a fresh Code session for a new conversation instead of continuing the old one", async () => {
    roomSetup();
    await roomLaunch();
    store.tasks.get("code")!.status = "idle";
    messages = [answer("first", "First room job done")];
    await relay.tick(); await relay.tick();
    expect(record().state).toBe("delivered");

    // A second user request opens a new conversation; the old session must not be reused.
    const room = store.rooms.get("room-1")!;
    const conversation = { requestId: "user-2", participantIds: ["one", "two"], turn: 1, maxTurns: 6 };
    room.messages.push({ id: "user-2", role: "user", text: "別の依頼", createdAt: 5 });
    room.messages.push({ id: "turn-2", role: "assistant", botId: "one", text: "", status: "working", createdAt: 6, conversation });
    expect(await relay.run("bot:one:room:room-1", "room-status-2", { action: "status" }, "session")).toMatchObject({ task: null });
    await relay.run("bot:one:room:room-1", "room-start-2", { action: "start", projectId: "project", prompt: "Second job" }, "session");
    expect(deps.create).toHaveBeenCalledTimes(2);
    expect(record().room?.conversation.requestId).toBe("user-2");
  });

  it("runs concurrent Room Code jobs for different members without a queue", async () => {
    roomSetup();
    let nextCode = 0;
    vi.mocked(deps.create).mockImplementation(async (input) => {
      const code = task(`code-${++nextCode}`, { status: "working" });
      store.tasks.set(code.id, code);
      input.beforePrompt(code);
      return code;
    });
    await roomLaunch();
    const room = store.rooms.get("room-1")!;
    const conversation = { requestId: "user-1", participantIds: ["one", "two"], turn: 2, maxTurns: 6 };
    room.messages.push({ id: "turn-2", role: "assistant", botId: "two", text: "", status: "working", createdAt: 4, conversation });
    const goalLoop = { acceptance: ["Tests pass"], maxTurns: 3, cooldownSeconds: 5, forceFullRun: false };
    const second = await relay.run("bot:two:room:room-1", "other-member", { action: "start", projectId: "project", prompt: "Same work", goalLoop }, "session");
    expect(second).toMatchObject({ state: "running", taskId: "code-2" });
    expect(deps.approve).toHaveBeenCalledTimes(2);
    expect(deps.create).toHaveBeenCalledTimes(2);
    expect(deps.create).toHaveBeenLastCalledWith(expect.objectContaining({ goalLoop }));
    expect(records().find((request) => request.id === second.requestId)).toMatchObject({ state: "running", codeTaskId: "code-2", goalLoop });
    expect(room.messages.find((message) => message.id === "turn-2")?.codeTaskId).toBe("code-2");

    store.tasks.get("code-2")!.status = "idle";
    messages = [answer("second", "二つ目の作業結果")];
    await relay.tick();
    expect(records().find((request) => request.id === second.requestId)?.state).toBe("delivered");
  });

  it("keeps another request's codeActivity when a sibling save targets the same Room message", async () => {
    roomSetup();
    let nextCode = 0;
    vi.mocked(deps.create).mockImplementation(async (input) => {
      const code = task(`code-${++nextCode}`, { status: "working" });
      store.tasks.set(code.id, code);
      input.beforePrompt(code);
      return code;
    });
    await roomLaunch();
    const room = store.rooms.get("room-1")!;
    const turn = room.messages.find((message) => message.id === "turn-1")!;
    turn.codeActivity = "読取 README.md";
    expect(turn.codeRequestId).toBeTruthy();

    await relay.run("bot:one:room:room-1", "sibling-start", { action: "start", projectId: "project", prompt: "Also fix tests" }, "session");
    expect(deps.create).toHaveBeenCalledTimes(2);
    expect(room.messages.find((message) => message.id === "turn-1")?.codeActivity).toBe("読取 README.md");
  });

  it("runs multiple Room Code jobs in parallel", async () => {
    roomSetup();
    const room = store.rooms.get("room-1")!;
    store.bots.set("three", { id: "three", name: "Three", enabled: true, permissionMode: "allow" } as BotDto);
    store.tasks.set("bot:three:room:room-1", task("bot:three:room:room-1", { kind: "bot", botId: "three" }));
    room.members.push("three");

    let nextCode = 0;
    vi.mocked(deps.create).mockImplementation(async (input) => {
      const code = task(`code-${++nextCode}`, { status: "working" });
      store.tasks.set(code.id, code);
      input.beforePrompt(code);
      return code;
    });
    await roomLaunch();
    const secondConversation = { requestId: "user-1", participantIds: ["one", "two", "three"], turn: 2, maxTurns: 6 };
    room.messages.push({ id: "turn-2", role: "assistant", botId: "two", text: "", status: "working", createdAt: 4, conversation: secondConversation });
    const second = await relay.run("bot:two:room:room-1", "queued-two", { action: "start", projectId: "project", prompt: "Second job" }, "session");
    const thirdConversation = { ...secondConversation, turn: 3 };
    room.messages.push({ id: "turn-3", role: "assistant", botId: "three", text: "", status: "working", createdAt: 5, conversation: thirdConversation });
    const third = await relay.run("bot:three:room:room-1", "queued-three", { action: "start", projectId: "project", prompt: "Third job" }, "session");
    expect(second).toMatchObject({ state: "running", taskId: "code-2" });
    expect(third).toMatchObject({ state: "running", taskId: "code-3" });
    expect(deps.create).toHaveBeenCalledTimes(3);
    expect(records().find((request) => request.id === second.requestId)).toMatchObject({ state: "running", codeTaskId: "code-2" });
    expect(records().find((request) => request.id === third.requestId)).toMatchObject({ state: "running", codeTaskId: "code-3" });
  });

  it("stops a parallel Room Code job without cancelling its sibling", async () => {
    roomSetup();
    let nextCode = 0;
    vi.mocked(deps.create).mockImplementation(async (input) => {
      const code = task(`code-${++nextCode}`, { status: "working" });
      store.tasks.set(code.id, code);
      input.beforePrompt(code);
      return code;
    });
    await roomLaunch();
    const room = store.rooms.get("room-1")!;
    const conversation = { requestId: "user-2", participantIds: ["one", "two"], turn: 1, maxTurns: 6 };
    room.messages.push({ id: "user-2", role: "user", text: "次の依頼", createdAt: 4 });
    room.messages.push({ id: "turn-2", role: "assistant", botId: "two", text: "", status: "working", createdAt: 5, conversation });
    const second = await relay.run("bot:two:room:room-1", "cancel-queued", { action: "start", projectId: "project", prompt: "Same work" }, "session");
    expect(second).toMatchObject({ state: "running" });
    expect(await stopBotCodeRequest("two", (second as { requestId: string }).requestId)).toMatchObject({
      state: "running",
      codeTaskId: "code-2",
    });
    expect(records().find((request) => request.id === (second as { requestId: string }).requestId)).toMatchObject({
      stoppedByUser: true,
      codeTaskId: "code-2",
    });
    expect(deps.create).toHaveBeenCalledTimes(2);
  });

  it("continues the Room only after a delivered report, and not when delivery fails", async () => {
    roomSetup();
    await roomLaunch();
    store.tasks.get("code")!.status = "idle";
    vi.mocked(deps.deliver).mockResolvedValueOnce(false);
    await relay.tick();
    expect(deps.afterDelivery).not.toHaveBeenCalled();
    const pending = record(); pending.nextAttemptAt = 0;
    writeFileSync(join(store.root, "bot-code-requests", `${pending.id}.json`), JSON.stringify(pending), "utf8");
    await relay.tick();
    expect(record().state).toBe("delivered");
    await vi.waitFor(() => expect(deps.afterDelivery).toHaveBeenCalledTimes(1));
    expect(vi.mocked(deps.afterDelivery!).mock.calls[0][0]).toMatchObject({ room: { id: "room-1" }, state: "delivered" });
    await relay.tick();
    expect(deps.afterDelivery).toHaveBeenCalledTimes(1);
  });
});

describe("durable Bot report acknowledgement", () => {
  const marker = { type: "custom_message", customType: BOT_CODE_RESULT, details: { requestId: "request" } };
  const final = { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Report" }] } };
  it("returns the reported text so a Room can reuse it verbatim", () => {
    expect(botCodeReportText([marker, final], "request")).toBe("Report");
    expect(botCodeReportText([marker], "request")).toBeUndefined();
  });
  it("requires an actual final answer after the matching internal message", () => {
    expect(hasBotCodeReport([marker], "request")).toBe(false);
    expect(hasBotCodeReport([final, marker], "request")).toBe(false);
    expect(hasBotCodeReport([marker, final], "request")).toBe(true);
    expect(hasBotCodeReport([marker, final], "other")).toBe(false);
    expect(hasBotCodeReport([marker, { type: "message", message: { ...final.message, stopReason: "error" } }], "request")).toBe(false);
    expect(hasBotCodeReport([marker, { type: "message", message: { role: "user" } }, final], "request")).toBe(false);
  });
});
