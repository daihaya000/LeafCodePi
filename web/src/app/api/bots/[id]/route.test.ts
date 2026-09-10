import { describe, expect, it, vi } from "vitest";
import type { BotDto } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  patchBot: vi.fn(),
  deleteBot: vi.fn(),
  normalizeBotSkills: vi.fn((value: unknown) => value),
  setTaskModel: vi.fn(),
  setTaskThinkingLevel: vi.fn(),
  setBotTools: vi.fn(),
  resetTaskConversation: vi.fn(),
  resetTaskSession: vi.fn(),
  destroyTask: vi.fn(),
  listTasks: vi.fn(() => []),
  listRooms: vi.fn(() => [] as { id: string; members: string[] }[]),
  patchRoom: vi.fn(),
}));
vi.mock("@/lib/bots", () => ({
  getBot: mocks.getBot,
  patchBot: mocks.patchBot,
  deleteBot: mocks.deleteBot,
  normalizeBotSkills: mocks.normalizeBotSkills,
  botTaskId: (id: string) => `bot:${id}`,
  BOT_TOOL_NAMES: ["bash", "powershell", "read", "write", "edit", "grep", "glob", "intercom"],
}));
vi.mock("@/lib/pi/harness", () => ({
  setTaskModel: mocks.setTaskModel,
  setTaskThinkingLevel: mocks.setTaskThinkingLevel,
  setBotTools: mocks.setBotTools,
  resetTaskConversation: mocks.resetTaskConversation,
  resetTaskSession: mocks.resetTaskSession,
  destroyTask: mocks.destroyTask,
}));
vi.mock("@/lib/store", () => ({ listTasks: mocks.listTasks }));
vi.mock("@/lib/rooms", () => ({ listRooms: mocks.listRooms, patchRoom: mocks.patchRoom }));

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
  it("returns the bot or 404", async () => {
    mocks.getBot.mockReturnValue(bot());
    const found = await GET(emptyRequest(), params("one"));
    expect(found.status).toBe(200);
    expect((await found.json()).bot.id).toBe("one");

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
      { model: "" },
      { permissionMode: "turbo" },
      { tools: ["unknown-tool"] },
      { extraRoots: ["relative/path"] },
      { avatarColor: "#12345" },
      { resetMessages: false },
      { thinkingLevel: "super" },
    ]) {
      const response = await PATCH(jsonRequest(body), params("one"));
      expect(response.status).toBe(400);
    }
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

  it("applies the model through the same live-session validation", async () => {
    mocks.getBot.mockReturnValue(bot());
    mocks.setTaskModel.mockResolvedValue({ thinkingLevel: "high" });
    mocks.patchBot.mockReturnValue({ ...bot(), model: "provider::model", thinkingLevel: "high" });
    const response = await PATCH(jsonRequest({ model: "provider::model" }), params("one"));
    expect(response.status).toBe(200);
    expect(mocks.setTaskModel).toHaveBeenCalledWith("bot:one", "provider::model");
    expect(mocks.patchBot).toHaveBeenCalledWith(
      "one",
      expect.objectContaining({ model: "provider::model", thinkingLevel: "high" }),
    );
  });
});

describe("DELETE /api/bots/[id]", () => {
  it("destroys bot tasks, deletes the bot, and returns ok", async () => {
    mocks.listTasks.mockReturnValue([{ id: "bot-task", botId: "one" }] as never);
    mocks.deleteBot.mockReturnValue(true);
    const response = await DELETE(emptyRequest(), params("one"));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(mocks.destroyTask).toHaveBeenCalledWith("bot-task");
  });

  it("removes the deleted Bot from every Room it was a member of", async () => {
    mocks.deleteBot.mockReturnValue(true);
    mocks.listRooms.mockReturnValue([
      { id: "room-a", members: ["one", "two"] },
      { id: "room-b", members: ["two"] },
    ]);

    const response = await DELETE(emptyRequest(), params("one"));

    expect(response.status).toBe(200);
    expect(mocks.patchRoom).toHaveBeenCalledTimes(1);
    expect(mocks.patchRoom).toHaveBeenCalledWith("room-a", { members: ["two"] });
  });

  it("returns 404 when the bot does not exist", async () => {
    mocks.deleteBot.mockReturnValue(false);
    const response = await DELETE(emptyRequest(), params("one"));
    expect(response.status).toBe(404);
    expect(mocks.patchRoom).not.toHaveBeenCalled();
  });
});