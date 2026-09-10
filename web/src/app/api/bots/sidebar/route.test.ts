import { describe, expect, it, vi } from "vitest";
import type { BotDto, RoomDto, TaskSummary, UiMessage } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  listBots: vi.fn(),
  listRooms: vi.fn(),
  getTask: vi.fn(),
  listTasks: vi.fn(),
  getTaskDetail: vi.fn(),
  listBotCodeRequests: vi.fn(),
  botTaskId: (id: string) => `bot:${id}`,
}));
vi.mock("@/lib/bots", () => ({ listBots: mocks.listBots, botTaskId: mocks.botTaskId }));
vi.mock("@/lib/rooms", () => ({ listRooms: mocks.listRooms }));
vi.mock("@/lib/store", () => ({ getTask: mocks.getTask, listTasks: mocks.listTasks }));
vi.mock("@/lib/pi/harness", () => ({ getTaskDetail: mocks.getTaskDetail }));
vi.mock("@/lib/pi/bot-code-relay", () => ({ listBotCodeRequests: mocks.listBotCodeRequests }));

import { GET } from "./route";

const bot = (id: string): BotDto => ({
  id,
  name: `Bot ${id}`,
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

const task = (id: string): TaskSummary =>
  ({ id, projectId: "p", status: "idle", sessionId: null, sessionFile: null }) as TaskSummary;

const room = (id: string, message?: { text: string; createdAt: number }): RoomDto =>
  ({
    id,
    name: `Room ${id}`,
    members: [],
    createdAt: "",
    updatedAt: "",
    messages: message ? [message as never] : [],
  }) as RoomDto;

describe("GET /api/bots/sidebar", () => {
  it("summarizes the latest message without splitting surrogate pairs", async () => {
    mocks.listTasks.mockReturnValue([]);
    mocks.listBots.mockReturnValue([bot("one")]);
    mocks.getTask.mockReturnValue(task("bot:one"));
    mocks.listBotCodeRequests.mockReturnValue([]);
    mocks.getTaskDetail.mockResolvedValue({
      messages: [
        {
          id: "m1",
          role: "assistant",
          createdAt: 1_700_000_000_000,
          parts: [{ type: "text", text: "🎉".repeat(100) }],
        } as UiMessage,
      ],
    });
    mocks.listRooms.mockReturnValue([]);

    const response = await GET();
    const body = await response.json();
    const summary = body.bots[0].lastMessageSummary as string;
    // 絵文字79個＋省略記号（コードポイント単位で割れない）
    expect(Array.from(summary)).toHaveLength(80);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.replaceAll("🎉", "").replace("…", "")).toBe("");
  });

  it("counts working bot tasks and detects in-flight code requests", async () => {
    mocks.listTasks.mockReturnValue([
      { ...task("code-a"), status: "working", botId: "one" },
      { ...task("code-b"), status: "working", botId: "one" },
      { ...task("code-c"), status: "working", botId: "two" },
    ]);
    mocks.listBots.mockReturnValue([bot("one"), bot("two")]);
    mocks.getTask.mockReturnValue(undefined);
    mocks.listBotCodeRequests.mockImplementation((id: string) =>
      id === "one" ? [{ state: "running" }] : [],
    );
    mocks.listRooms.mockReturnValue([]);

    const body = await (await GET()).json();
    expect(body.bots[0]).toMatchObject({ id: "one", codeSessionCount: 2, codeInProgress: true });
    expect(body.bots[1]).toMatchObject({ id: "two", codeSessionCount: 1, codeInProgress: false });
  });

  it("passes through room previews and tolerates invalid timestamps", async () => {
    mocks.listTasks.mockReturnValue([]);
    mocks.listBots.mockReturnValue([]);
    mocks.listRooms.mockReturnValue([
      room("r1", { text: "こんにちは", createdAt: 1_700_000_000_000 }),
      room("r2", { text: "壊れた時刻", createdAt: Number.NaN }),
    ]);

    const body = await (await GET()).json();
    expect(body.rooms[0]).toMatchObject({
      id: "r1",
      lastMessageSummary: "こんにちは",
      lastMessageAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(body.rooms[1]).toMatchObject({ id: "r2", lastMessageSummary: "壊れた時刻", lastMessageAt: null });
  });

  it("keeps the preview null when the task detail fails", async () => {
    mocks.listTasks.mockReturnValue([]);
    mocks.listBots.mockReturnValue([bot("one")]);
    mocks.getTask.mockReturnValue(task("bot:one"));
    mocks.getTaskDetail.mockRejectedValue(new Error("boom"));
    mocks.listRooms.mockReturnValue([]);

    const body = await (await GET()).json();
    expect(body.bots[0]).toMatchObject({ id: "one", lastMessageSummary: null, lastMessageAt: null });
  });
});