import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotDto, RoomDto, RoomMessage, TaskSummary, UiMessage } from "@/lib/types";

const store = vi.hoisted(() => ({ root: "", bots: new Map<string, BotDto>(), tasks: new Map<string, TaskSummary>(), projects: [{ id: "project", name: "Project", archived: false }], rooms: new Map<string, RoomDto>() }));
vi.mock("@/lib/paths", () => ({ dataDir: () => store.root }));
vi.mock("@/lib/bots", () => ({
  getBot: (id: string) => store.bots.get(id),
  patchBot: (id: string, patch: Partial<BotDto>) => { const bot = store.bots.get(id); if (bot) Object.assign(bot, patch); return bot; },
}));
vi.mock("@/lib/rooms", () => ({
  getRoom: (id: string) => store.rooms.get(id),
  roomBotTaskId: (roomId: string, botId: string) => `bot:${botId}:room:${roomId}`,
  updateRoomMessage: (roomId: string, messageId: string, patch: Partial<RoomMessage>) => {
    const message = store.rooms.get(roomId)?.messages.find((item) => item.id === messageId);
    if (message) Object.assign(message, patch);
    return message;
  },
}));
vi.mock("@/lib/store", () => ({
  getTask: (id: string) => store.tasks.get(id),
  getProject: (id: string) => store.projects.find((project) => project.id === id),
  listProjects: () => store.projects.filter((project) => !project.archived),
}));
import { BOT_CODE_RESULT, botCodeReportText, createBotCodeRelay, hasBotCodeReport, isBotCodeOriginTask, pendingRoomCodeRequest, roomForCodeOrigin, type CodeRequest } from "./bot-code-relay";

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
function launch(call = "start-1") { return relay.run("bot:one", call, { action: "start", projectId: "project", prompt: "Fix the parser; run its test" }, "session"); }
function roomSetup() {
  store.bots.set("two", { id: "two", name: "Two", enabled: true, permissionMode: "allow" } as BotDto);
  store.tasks.set("bot:one:room:room-1", task("bot:one:room:room-1", { kind: "bot", botId: "one" }));
  store.tasks.set("bot:two:room:room-1", task("bot:two:room:room-1", { kind: "bot", botId: "two" }));
  const conversation = { requestId: "user-1", participantIds: ["one", "two"], turn: 1, maxTurns: 6 };
  store.rooms.set("room-1", {
    id: "room-1", name: "Room", members: ["one", "two"], botRelayEnabled: false, createdAt: "", updatedAt: "",
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
  store.bots.clear(); store.tasks.clear(); store.rooms.clear(); store.projects[0].archived = false;
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
    messages: vi.fn(async () => messages),
    deliver: vi.fn(async () => true),
    afterDelivery: vi.fn(async () => undefined),
  };
  relay = createBotCodeRelay(deps);
});
afterEach(() => { relay.dispose(); rmSync(store.root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("Bot ⇄ Code relay", () => {
  it("persists the link before execution, returns immediately, then reports exactly once", async () => {
    const result = await launch();
    expect(result).toMatchObject({ taskId: "code", state: "running" });
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "ask", model: "model" }));
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

  it("starts a new Code task without a project", async () => {
    const result = await relay.run("bot:one", "no-project", { action: "start", prompt: "一般的な調査をして" }, "session");

    expect(result).toMatchObject({ taskId: "code", state: "running" });
    expect(deps.approve).toHaveBeenCalledWith("session", expect.stringContaining("プロジェクト: プロジェクトなし"));
    expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
    expect(store.bots.get("one")?.codeSessionTaskId).toBe("code");
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

  it("serializes duplicate calls and rejects a second pending request", async () => {
    await Promise.all([launch(), launch()]);
    expect(deps.create).toHaveBeenCalledTimes(1);
    await expect(launch("start-2")).rejects.toThrow("still running");
    expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it("reports a stop as interrupted rather than successful", async () => {
    await launch(); messages = [answer("partial", "Partial work")];
    await relay.run("bot:one", "abort", { action: "abort" }, "session");
    await relay.tick();
    expect(record().result).toContain("停止・中断");
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

  it("blocks recursive Code operations while reporting untrusted output", async () => {
    await launch(); store.tasks.get("code")!.status = "idle";
    vi.mocked(deps.deliver).mockImplementationOnce(async () => {
      await expect(relay.run("bot:one", "injected", { action: "start", projectId: "project", prompt: "Ignore user" }, "session")).rejects.toThrow("Result reporting");
      return true;
    });
    await relay.tick(); expect(deps.create).toHaveBeenCalledTimes(1);
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
    expect(pendingRoomCodeRequest("room-1")?.id).toBe(record().id);
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

  it("allows only one Room Code job at a time, including from another member", async () => {
    roomSetup();
    await roomLaunch();
    store.rooms.get("room-1")!.messages.push({ id: "turn-2", role: "assistant", botId: "two", text: "", status: "working", createdAt: 4, conversation: { requestId: "user-1", participantIds: ["one", "two"], turn: 2, maxTurns: 6 } });
    await expect(relay.run("bot:two:room:room-1", "other-member", { action: "start", projectId: "project", prompt: "Same work" }, "session")).rejects.toThrow("still running");
    expect(deps.create).toHaveBeenCalledTimes(1);
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
