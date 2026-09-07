import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeRequest } from "./pi/bot-code-relay";
import type { BotDto, RoomDto, TaskDetail, UiMessage } from "./types";

const state = vi.hoisted(() => ({ root: "", details: new Map<string, TaskDetail>(), promptTask: vi.fn(), pendingRoom: vi.fn(() => undefined as CodeRequest | undefined) }));
vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  dataDir: () => state.root,
  storePath: () => join(state.root, "store.json"),
}));
vi.mock("@/lib/pi/harness", () => ({
  getTaskDetail: async (id: string) => state.details.get(id),
  promptTask: state.promptTask,
}));
vi.mock("@/lib/pi/bot-code-relay", () => ({ pendingRoomCodeRequest: state.pendingRoom }));

import { createBot } from "./bots";
import { createRoom, ensureRoomBotTask, getRoom, appendRoomMessage, patchRoom } from "./rooms";
import { getTask } from "./store";
import { deliverRoomCodeReport, resumeRoomAfterCode, runRoomConversation } from "./room-runtime";

function assistant(id: string, text: string): UiMessage {
  return { id, role: "assistant", createdAt: Date.now(), parts: [{ id: `${id}-text`, type: "text", text }] };
}
function setup(names = ["A", "B"]) {
  const bots = names.map((name) => createBot({ name }));
  const room = createRoom({ members: bots.map((bot) => bot.id) });
  for (const bot of bots) {
    const taskId = ensureRoomBotTask(room, bot);
    state.details.set(taskId, { ...getTask(taskId)!, messages: [], isStreaming: false, isCompacting: false });
  }
  const user = appendRoomMessage(room.id, { role: "user", text: "残作業も進めて" })!;
  return { room: getRoom(room.id)!, bots, user };
}
function codeRequest(room: RoomDto, bot: BotDto, extra: Partial<CodeRequest> = {}): CodeRequest {
  const requestId = getRoom(room.id)!.messages.find((message) => message.role === "user")!.id;
  return {
    id: "code-request", botId: bot.id, originTaskId: `bot:${bot.id}:room:${room.id}`, codeTaskId: "code",
    state: "ready", prompt: "Fix", baseline: null, result: JSON.stringify({ outcome: "実行終了", output: "done" }),
    room: { id: room.id, responseId: "turn", conversation: { requestId, participantIds: room.members, turn: 1, maxTurns: 6 } },
    ...extra,
  };
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "leafcode-room-runtime-"));
  state.pendingRoom.mockReturnValue(undefined);
  state.promptTask.mockImplementation(async (id: string) => {
    const detail = state.details.get(id)!;
    detail.messages = [...detail.messages, assistant(`reply-${detail.messages.length}`, "進めた内容\nROOM_ACTION: DONE")];
  });
});
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true });
  state.details.clear();
  state.promptTask.mockReset();
  state.pendingRoom.mockReset();
  vi.restoreAllMocks();
});

describe("room conversation with delegated work", () => {
  it("records the request/turn correlation on each reply so a Code receipt can bind to it", async () => {
    const { room, bots, user } = setup();
    await runRoomConversation(room, bots, "残作業も進めて", user.id);
    const replies = getRoom(room.id)!.messages.filter((message) => message.role === "assistant");
    expect(replies).not.toHaveLength(0);
    for (const reply of replies) expect(reply.conversation).toMatchObject({ requestId: user.id, participantIds: room.members, maxTurns: 6 });
  });

  it("pauses instead of handing off while a Code request is still outstanding", async () => {
    const { room, bots, user } = setup();
    state.pendingRoom.mockReturnValue(codeRequest(room, bots[0], { state: "running" }));
    await runRoomConversation(room, bots, "残作業も進めて", user.id);
    expect(state.promptTask).toHaveBeenCalledTimes(1);
    expect(getRoom(room.id)!.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  it("appends the delivered report once and hands the floor to the requested member", async () => {
    const { room, bots } = setup();
    const request = codeRequest(room, bots[0]);
    expect(deliverRoomCodeReport(request, `修正を適用しテストは成功。\nROOM_ACTION: NEXT ${bots[1].id}`)).toBe(true);
    const report = getRoom(room.id)!.messages.at(-1)!;
    expect(report).toMatchObject({ botId: bots[0].id, codeState: "delivered", codeTaskId: "code", status: "done" });
    expect(report.text).not.toContain("ROOM_ACTION");
    expect(request.room?.nextBotId).toBe(bots[1].id);
    // A retry after a restart must not duplicate the report.
    deliverRoomCodeReport(request, `修正を適用しテストは成功。\nROOM_ACTION: NEXT ${bots[1].id}`);
    expect(getRoom(room.id)!.messages.filter((message) => message.codeRequestId === request.id)).toHaveLength(1);

    await resumeRoomAfterCode(request);
    expect(state.promptTask).toHaveBeenCalledTimes(1);
    expect(state.promptTask.mock.calls[0][0]).toBe(`bot:${bots[1].id}:room:${room.id}`);
    expect(state.promptTask.mock.calls[0][1]).toContain("修正を適用しテストは成功。");
  });

  it.each<[string, (request: CodeRequest) => CodeRequest]>([
    ["a concluded discussion", (request) => ({ ...request, room: { ...request.room!, complete: true } })],
    ["a failed Code run", (request) => ({ ...request, result: JSON.stringify({ outcome: "失敗", error: "boom" }) })],
    ["an interrupted Code run", (request) => ({ ...request, result: JSON.stringify({ outcome: "停止・中断" }) })],
    ["an unreadable result", (request) => ({ ...request, result: "not json" })],
    ["an exhausted turn budget", (request) => ({ ...request, room: { ...request.room!, conversation: { ...request.room!.conversation, turn: 6, maxTurns: 6 } } })],
  ])("does not continue automatically after %s", async (_label, change) => {
    const { room, bots } = setup();
    await resumeRoomAfterCode(change(codeRequest(room, bots[0])));
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it("does not continue or report when the user has moved on", async () => {
    const { room, bots } = setup();
    const request = codeRequest(room, bots[0]);
    appendRoomMessage(room.id, { role: "user", text: "止めて" });
    await resumeRoomAfterCode(request);
    expect(state.promptTask).not.toHaveBeenCalled();
    // The report still belongs in the transcript even though the conversation stopped.
    expect(deliverRoomCodeReport(request, "作業結果です。\nROOM_ACTION: DONE")).toBe(true);
  });

  it("refuses a report for a bot that left the room and never routes to a non-participant", async () => {
    const { room, bots } = setup(["A", "B", "C"]);
    const outside = bots[2];
    const request = codeRequest(room, bots[0]);
    request.room!.conversation.participantIds = [bots[0].id, bots[1].id];
    expect(deliverRoomCodeReport(request, `外部へ\nROOM_ACTION: NEXT ${outside.id}`)).toBe(true);
    expect(request.room?.nextBotId).toBeUndefined();
    expect(getRoom(room.id)!.messages.at(-1)!.text).toContain(`ROOM_ACTION: NEXT ${outside.id}`);
    patchRoom(room.id, { members: [bots[1].id, outside.id] });
    expect(deliverRoomCodeReport({ ...request, id: "other" }, "結果\nROOM_ACTION: DONE")).toBe(false);
  });
});
