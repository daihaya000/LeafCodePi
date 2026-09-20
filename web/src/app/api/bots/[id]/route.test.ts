import { describe, expect, it, vi } from "vitest";
import type { BotDto } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  patchBot: vi.fn(),
  deleteBot: vi.fn(),
  normalizeBotSkills: vi.fn((value: unknown) => value),
  setBotModel: vi.fn(),
  setBotThinkingLevel: vi.fn(),
  setBotPermissionMode: vi.fn(),
  setBotTools: vi.fn(),
  resetTaskConversation: vi.fn(),
  requestBotSoulReload: vi.fn(),
  resetTaskSession: vi.fn(),
  destroyTask: vi.fn(),
  stopBotCodeTask: vi.fn(async () => ({ id: "code-1", status: "idle" })),
  abortTask: vi.fn(async () => ({ id: "code-1", status: "idle" })),
  abortTaskIncludingColdGoalLoop: vi.fn(async () => ({ id: "code-1", status: "idle" })),
  listTasks: vi.fn(() => []),
  getTask: vi.fn(),
  listRooms: vi.fn(() => [] as { id: string; members: string[] }[]),
  patchRoom: vi.fn(),
  detachBotFromRoomRuntime: vi.fn(async () => undefined),
  stopAllCodeSessionsForBot: vi.fn(async () => 0),
  stopOneToOneCodeSessionsForBot: vi.fn(async () => 0),
  isWebUiRequestAuthorized: vi.fn(() => false),
}));
vi.mock("@/lib/bots", () => ({
  getBot: mocks.getBot,
  patchBot: mocks.patchBot,
  deleteBot: mocks.deleteBot,
  normalizeBotSkills: mocks.normalizeBotSkills,
  botTaskId: (id: string) => `bot:${id}`,
  BOT_TOOL_NAMES: ["bash", "powershell", "read", "write", "edit", "grep", "glob", "intercom"],
  // Mirror the real code-point basis: a mocked `.length` check would hide the bound's behavior.
  isBotNameWithinSize: (value: string) => Array.from(value).length <= 100,
  isBotLabelWithinSize: (value: string) => Array.from(value).length <= 100,
}));
vi.mock("@/lib/pi/harness", () => ({
  setBotModel: mocks.setBotModel,
  setBotThinkingLevel: mocks.setBotThinkingLevel,
  setBotPermissionMode: mocks.setBotPermissionMode,
  setBotTools: mocks.setBotTools,
  resetTaskConversation: mocks.resetTaskConversation,
  requestBotSoulReload: mocks.requestBotSoulReload,
  resetTaskSession: mocks.resetTaskSession,
  destroyTask: mocks.destroyTask,
  stopBotCodeTask: mocks.stopBotCodeTask,
  abortTask: mocks.abortTask,
  abortTaskIncludingColdGoalLoop: mocks.abortTaskIncludingColdGoalLoop,
}));
vi.mock("@/lib/store", () => ({ listTasks: mocks.listTasks, getTask: mocks.getTask }));
vi.mock("@/lib/rooms", () => ({ listRooms: mocks.listRooms, patchRoom: mocks.patchRoom }));
vi.mock("@/lib/room-runtime", () => ({ detachBotFromRoomRuntime: mocks.detachBotFromRoomRuntime }));
vi.mock("@/lib/pi/bot-code-relay", () => ({
  stopAllCodeSessionsForBot: mocks.stopAllCodeSessionsForBot,
  stopOneToOneCodeSessionsForBot: mocks.stopOneToOneCodeSessionsForBot,
}));
vi.mock("@/lib/webui-auth", () => ({
  isWebUiRequestAuthorized: mocks.isWebUiRequestAuthorized,
}));

import { NextRequest } from "next/server";
import { beforeEach } from "vitest";
import { DELETE, GET, PATCH } from "./route";

const emptyRequest = () => new Request("http://localhost") as NextRequest;

const bot = (id = "one"): BotDto => ({
  id,
  name: "Bot",
  label: "",
  soul: "",
  avatarColor: "#3B82F6",
  avatarImage: null,
  model: null,
  thinkingLevel: null,
  permissionMode: null,
  codeAutoApprove: false,
  skills: { mode: "inherit", include: [], exclude: [] },
  extraRoots: [],
  enabled: true,
  notificationsEnabled: true,
  createdAt: "",
  updatedAt: "",
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(() => { vi.clearAllMocks(); });
const jsonRequest = (body: unknown): NextRequest =>
  new Request("http://localhost/api/bots/one", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;

describe("GET /api/bots/[id]", () => {
  it("returns the bot or 404 and refreshes its live tools", async () => {
    const foundBot = { ...bot(), tools: ["read", "grep"] as const };
    mocks.getBot.mockReturnValue(foundBot);
    const found = await GET(emptyRequest(), params("one"));
    expect(found.status).toBe(200);
    expect((await found.json()).bot.id).toBe("one");
    expect(mocks.setBotTools).toHaveBeenCalledWith("one", foundBot.tools);

    mocks.getBot.mockReturnValue(undefined);
    const missing = await GET(emptyRequest(), params("one"));
    expect(missing.status).toBe(404);
  });
});

describe("PATCH /api/bots/[id]", () => {
  it("rejects invalid fields", async () => {
    mocks.getBot.mockReturnValue(bot());
    for (const body of [
      { name: "  " },
      { name: "x".repeat(101) },
      { label: "x".repeat(101) },
      { soul: "x".repeat(128 * 1024 + 1) },
      { soul: "bad\0soul" },
      { model: "" },
      { ttsVoice: 42 },
      { permissionMode: "turbo" },
      { tools: ["unknown-tool"] },
      { tools: ["read", 123] },
      { skills: { mode: "include", include: [""], exclude: [] } },
      { extraRoots: ["relative/path"] },
      { avatarColor: "#12345" },
      { resetMessages: false },
      { thinkingLevel: "super" },
    ]) {
      const response = await PATCH(jsonRequest(body), params("one"));
      expect(response.status).toBe(400);
    }
  });

  it("rejects non-object JSON bodies", async () => {
    mocks.getBot.mockReturnValue(bot());

    const response = await PATCH(jsonRequest([]), params("one"));

    expect(response.status).toBe(400);
    expect(mocks.patchBot).not.toHaveBeenCalled();
  });

  it("patches simple fields and returns the updated bot", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue({ ...bot(), name: "Renamed", avatarColor: "#EF4444" });
    const response = await PATCH(
      jsonRequest({ name: " Renamed ", avatarColor: "#EF4444" }),
      params("one"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bot: expect.objectContaining({ name: "Renamed", avatarColor: "#EF4444" }),
    });
    expect(mocks.patchBot).toHaveBeenCalledWith(
      "one",
      expect.objectContaining({ name: "Renamed", avatarColor: "#EF4444" }),
    );
  });

  it("allows clearing the optional label", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue({ ...bot(), label: "" });
    const response = await PATCH(jsonRequest({ label: "" }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.patchBot).toHaveBeenCalledWith("one", { label: "" });
  });

  it("rejects unauthenticated codeAutoApprove updates", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.isWebUiRequestAuthorized.mockReturnValue(false);
    const response = await PATCH(jsonRequest({ codeAutoApprove: true }), params("one"));
    expect(response.status).toBe(403);
    expect(mocks.patchBot).not.toHaveBeenCalled();
  });

  it("accepts authenticated codeAutoApprove updates", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.isWebUiRequestAuthorized.mockReturnValue(true);
    mocks.patchBot.mockReturnValue({ ...bot(), codeAutoApprove: true });
    const response = await PATCH(jsonRequest({ codeAutoApprove: true }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.patchBot).toHaveBeenCalledWith("one", expect.objectContaining({ codeAutoApprove: true }));
  });

  it("accepts the intercom opt-in setting", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue({ ...bot(), intercomEnabled: true });
    const response = await PATCH(jsonRequest({ intercomEnabled: true }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.patchBot).toHaveBeenCalledWith("one", expect.objectContaining({ intercomEnabled: true }));
  });

  it("accepts intercom scope and fanout opt-in", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue({ ...bot(), intercomScopeId: "proj-a", intercomFanoutEnabled: true });
    const response = await PATCH(jsonRequest({ intercomScopeId: " proj-a ", intercomFanoutEnabled: true }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.patchBot).toHaveBeenCalledWith("one", expect.objectContaining({
      intercomScopeId: "proj-a",
      intercomFanoutEnabled: true,
    }));
  });

  it("rejects an oversized intercom scope id", async () => {
    mocks.getBot.mockReturnValue(bot());
    const response = await PATCH(jsonRequest({ intercomScopeId: "x".repeat(65) }), params("one"));
    expect(response.status).toBe(400);
    expect(mocks.patchBot).not.toHaveBeenCalled();
  });

  it("accepts intercom in the Bot tool allowlist", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue({ ...bot(), tools: ["read", "intercom"] });
    const response = await PATCH(jsonRequest({ tools: ["read", "intercom"] }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.patchBot).toHaveBeenCalledWith(
      "one",
      expect.objectContaining({ tools: ["read", "intercom"] }),
    );
  });

  it("resets the whole conversation only for resetMessages, and re-reads the session for a SOUL edit", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue({ ...bot(), codeSessionTaskId: "code-1" });
    mocks.getTask.mockReturnValue({ id: "code-1", status: "working" });

    const reset = await PATCH(jsonRequest({ resetMessages: true }), params("one"));
    expect(reset.status).toBe(200);
    expect(mocks.stopOneToOneCodeSessionsForBot).toHaveBeenCalledWith("one");
    expect(mocks.stopBotCodeTask).toHaveBeenCalledWith("one", "code-1");
    expect(mocks.resetTaskConversation).toHaveBeenCalledWith("bot:one");
    expect(mocks.resetTaskSession).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue(bot());
    const soul = await PATCH(jsonRequest({ soul: "Be precise" }), params("one"));
    expect(soul.status).toBe(200);
    expect(mocks.requestBotSoulReload).toHaveBeenCalledWith("one");
    expect(mocks.resetTaskSession).not.toHaveBeenCalled();
    expect(mocks.resetTaskConversation).not.toHaveBeenCalled();
  });

  it("rebuilds the session when the skill allowlist changes", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue(bot());

    const response = await PATCH(jsonRequest({ skills: { mode: "include", include: ["review"], exclude: [] } }), params("one"));

    expect(response.status).toBe(200);
    // Skills shape the system prompt like SOUL: defer reload until the next safe turn boundary.
    expect(mocks.requestBotSoulReload).toHaveBeenCalledWith("one");
    expect(mocks.resetTaskSession).not.toHaveBeenCalled();
    expect(mocks.resetTaskConversation).not.toHaveBeenCalled();
  });

  it("persists a per-Bot TTS voice without changing the live text model", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue({ ...bot(), ttsVoice: "1257529344" });
    const response = await PATCH(jsonRequest({ ttsVoice: " 1257529344 " }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.setBotModel).not.toHaveBeenCalled();
    expect(mocks.patchBot).toHaveBeenCalledWith(
      "one",
      expect.objectContaining({ ttsVoice: "1257529344" }),
    );
  });

  it("applies the model through the same live-session validation", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.setBotModel.mockResolvedValue({ thinkingLevel: "high" });
    mocks.patchBot.mockReturnValue({ ...bot(), model: "provider::model", thinkingLevel: "high" });
    const response = await PATCH(jsonRequest({ model: "provider::model" }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.setBotModel).toHaveBeenCalledWith("one", "provider::model");
    expect(mocks.patchBot).toHaveBeenCalledWith(
      "one",
      expect.objectContaining({ model: "provider::model", thinkingLevel: "high" }),
    );
  });

  it("applies permissionMode through the live-session path", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.setBotPermissionMode.mockResolvedValue(undefined);
    mocks.patchBot.mockReturnValue({ ...bot(), permissionMode: "ask" });
    const response = await PATCH(jsonRequest({ permissionMode: "ask" }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.setBotPermissionMode).toHaveBeenCalledWith("one", "ask");
    expect(mocks.patchBot).toHaveBeenCalledWith("one", expect.objectContaining({ permissionMode: "ask" }));
  });

  it("detaches Room runtime when the Bot is disabled without removing membership", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue({ ...bot(), enabled: false });
    mocks.listRooms.mockReturnValue([
      { id: "room-a", members: ["one", "two"] },
      { id: "room-b", members: ["two"] },
    ]);
    const response = await PATCH(jsonRequest({ enabled: false }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.detachBotFromRoomRuntime).toHaveBeenCalledWith("room-a", "one");
    expect(mocks.detachBotFromRoomRuntime).not.toHaveBeenCalledWith("room-b", "one");
    expect(mocks.stopOneToOneCodeSessionsForBot).toHaveBeenCalledWith("one");
    expect(mocks.stopBotCodeTask).not.toHaveBeenCalled();
    expect(mocks.abortTaskIncludingColdGoalLoop).toHaveBeenCalledWith("bot:one");
    expect(mocks.patchRoom).not.toHaveBeenCalled();
  });

  it("stops a linked Code session on disable even without an active relay outbox", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.patchBot.mockReturnValue({ ...bot(), enabled: false, codeSessionTaskId: "code-loop" });
    mocks.getTask.mockReturnValue({ id: "code-loop", status: "working" });
    mocks.listRooms.mockReturnValue([]);
    const response = await PATCH(jsonRequest({ enabled: false }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.stopOneToOneCodeSessionsForBot).toHaveBeenCalledWith("one");
    expect(mocks.stopBotCodeTask).toHaveBeenCalledWith("one", "code-loop");
    expect(mocks.abortTaskIncludingColdGoalLoop).toHaveBeenCalledWith("bot:one");
  });
});

describe("DELETE /api/bots/[id]", () => {
  it("stops a linked Code session on delete even without an active relay outbox", async () => {
    mocks.getBot.mockReturnValue({ ...bot(), codeSessionTaskId: "code-loop" });
    mocks.getTask.mockReturnValue({ id: "code-loop", status: "working" });
    mocks.deleteBot.mockReturnValue(true);

    const response = await DELETE(emptyRequest(), params("one"));

    expect(response.status).toBe(200);
    expect(mocks.stopAllCodeSessionsForBot).toHaveBeenCalledWith("one");
    expect(mocks.stopBotCodeTask).toHaveBeenCalledWith("one", "code-loop");
  });

  it("destroys bot and Code tasks, deletes the bot, and returns ok", async () => {
    mocks.listTasks.mockReturnValue([
      { id: "bot-task", botId: "one", kind: "bot" },
      { id: "code-task", botId: "one", kind: "code" },
    ] as never);
    mocks.deleteBot.mockReturnValue(true);
    const response = await DELETE(emptyRequest(), params("one"));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(mocks.stopAllCodeSessionsForBot).toHaveBeenCalledWith("one");
    expect(mocks.listTasks).toHaveBeenCalledWith(true, "all");
    expect(mocks.destroyTask).toHaveBeenCalledWith("bot-task");
    expect(mocks.destroyTask).toHaveBeenCalledWith("code-task");
  });

  it("continues deletion when an owned task disappeared concurrently", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.listTasks.mockReturnValue([{ id: "stale-task", botId: "one" }] as never);
    mocks.destroyTask.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }));
    mocks.deleteBot.mockReturnValue(true);

    const response = await DELETE(emptyRequest(), params("one"));

    expect(response.status).toBe(200);
    expect(mocks.deleteBot).toHaveBeenCalledWith("one");
  });

  it("keeps the Bot when Room membership cleanup fails", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.listRooms.mockReturnValue([{ id: "room-a", members: ["one"] }]);
    mocks.patchRoom.mockImplementationOnce(() => { throw new Error("room write failed"); });

    await expect(DELETE(emptyRequest(), params("one"))).rejects.toThrow("room write failed");
    expect(mocks.deleteBot).not.toHaveBeenCalled();
  });

  it("removes the deleted Bot from every Room it was a member of", async () => {
    mocks.deleteBot.mockReturnValue(true);
    mocks.listRooms.mockReturnValue([
      { id: "room-a", members: ["one", "two"] },
      { id: "room-b", members: ["two"] },
    ]);

    const response = await DELETE(emptyRequest(), params("one"));

    expect(response.status).toBe(200);
    expect(mocks.detachBotFromRoomRuntime).toHaveBeenCalledWith("room-a", "one");
    expect(mocks.detachBotFromRoomRuntime).not.toHaveBeenCalledWith("room-b", "one");
    expect(mocks.patchRoom).toHaveBeenCalledTimes(1);
    expect(mocks.patchRoom).toHaveBeenCalledWith("room-a", { members: ["two"] });
  });

  it("returns 404 without tearing down resources when the bot does not exist", async () => {
    mocks.getBot.mockReturnValue(undefined);
    const response = await DELETE(emptyRequest(), params("one"));
    expect(response.status).toBe(404);
    expect(mocks.stopAllCodeSessionsForBot).not.toHaveBeenCalled();
    expect(mocks.destroyTask).not.toHaveBeenCalled();
    expect(mocks.deleteBot).not.toHaveBeenCalled();
    expect(mocks.patchRoom).not.toHaveBeenCalled();
  });
});