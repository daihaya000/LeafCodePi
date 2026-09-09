import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeRequest } from "./pi/bot-code-relay";
import type { BotDto, RoomDto, RoomHandoff, TaskDetail, UiMessage } from "./types";

const state = vi.hoisted(() => ({
  root: "", details: new Map<string, TaskDetail>(), promptTask: vi.fn(),
  pendingRoom: vi.fn<(roomId: string, requestId: string, excludeRequestId?: string) => CodeRequest | undefined>(() => undefined),
  activeCodeRequests: new Map<string, CodeRequest>(),
  settledCodeRequests: new Map<string, CodeRequest>(),
  listeners: new Map<string, Set<(payload: Record<string, unknown>) => void>>(),
}));
vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  dataDir: () => state.root,
  storePath: () => join(state.root, "store.json"),
}));
vi.mock("@/lib/pi/harness", () => ({
  getTaskDetail: async (id: string) => state.details.get(id),
  promptTask: state.promptTask,
  subscribeTask: (id: string, listener: (payload: Record<string, unknown>) => void) => {
    const listeners = state.listeners.get(id) ?? new Set<(payload: Record<string, unknown>) => void>();
    state.listeners.set(id, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));
vi.mock("@/lib/pi/bot-code-relay", () => ({
  pendingRoomCodeRequestForTurn: state.pendingRoom,
  roomCodeRequestForRoom: (_roomId: string, requestId: string) => state.activeCodeRequests.get(requestId),
  settledRoomCodeRequest: (_roomId: string, requestId: string) => state.settledCodeRequests.get(requestId),
}));

import { createBot } from "./bots";
import { createRoom, ensureRoomBotTask, getRoom, appendRoomMessage, patchRoom, updateRoomHandoffs, updateRoomMessage } from "./rooms";
import { getTask, patchTask } from "./store";
import { cancelPendingRoomHandoffs, deliverRoomCodeReport, registerRoomHandoff, resumeRoomAfterCode, runRoomConversation, settleRoomHandoffs, settleStaleRoomTurns } from "./room-runtime";

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
  state.activeCodeRequests.clear();
  state.settledCodeRequests.clear();
  state.promptTask.mockImplementation(async (id: string) => {
    const detail = state.details.get(id)!;
    detail.messages = [...detail.messages, assistant(`reply-${detail.messages.length}`, "進めた内容\nROOM_ACTION: DONE")];
  });
});
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true });
  state.listeners.clear();
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
    for (const reply of replies) expect(reply.conversation).toMatchObject({ requestId: user.id, participantIds: room.members, maxTurns: 4 });
  });

  it("shows the reply while it is still streaming and hides the half-written directive", async () => {
    const { room, bots, user } = setup();
    const taskId = `bot:${bots[0].id}:room:${room.id}`;
    const seen: string[] = [];
    state.promptTask.mockImplementation(async (id: string) => {
      if (id !== taskId) { state.details.get(id)!.messages = [assistant("other", "別の発言\nROOM_ACTION: DONE")]; return; }
      const emit = (text: string) => {
        for (const listener of state.listeners.get(id) ?? []) listener({ type: "delta", message: assistant("stream", text) });
        seen.push(getRoom(room.id)!.messages.at(-1)!.text);
      };
      emit("途中まで");
      vi.setSystemTime(Date.now() + 500);
      emit("途中までの続きです。\nROOM_ACT");
      vi.setSystemTime(Date.now() + 500);
      emit("途中までの続きです。\nROOM_ACTION: DONE");
      state.details.get(id)!.messages = [assistant("stream", "途中までの続きです。\nROOM_ACTION: DONE")];
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await runRoomConversation(room, bots, "残作業も進めて", user.id);
    } finally { vi.useRealTimers(); }
    expect(seen[0]).toBe("途中まで");
    expect(seen.at(-1)).toBe("途中までの続きです。");
    expect(seen.some((text) => text.includes("ROOM_ACT"))).toBe(false);
    const final = getRoom(room.id)!.messages.at(-1)!;
    expect(final).toMatchObject({ status: "done", text: "途中までの続きです。" });
    // The stream listener must not outlive the turn.
    expect(state.listeners.get(taskId)?.size ?? 0).toBe(0);
  });

  it("mirrors what the delegated Code run is doing, and clears it once the request settles", async () => {
    const { room, bots, user } = setup();
    const request = codeRequest(room, bots[0], { state: "running", codeTaskId: "code-task" });
    const turn = appendRoomMessage(room.id, { role: "assistant", botId: bots[0].id, text: "依頼しました", status: "done", codeRequestId: request.id, codeTaskId: "code-task", codeState: "running" })!;
    request.room!.responseId = turn.id;
    state.pendingRoom.mockReturnValue(request);
    // The bot's turn ends having handed work to Code.
    state.promptTask.mockImplementation(async (id: string) => {
      state.details.get(id)!.messages = [assistant("reply", "Codeに依頼しました。\nROOM_ACTION: DONE")];
    });
    await runRoomConversation(room, bots, "残作業も進めて", user.id);

    const emit = (payload: Record<string, unknown>) => { for (const listener of state.listeners.get("code-task") ?? []) listener(payload); };
    emit({ type: "delta", message: { id: "m1", role: "assistant", createdAt: 1, parts: [{ id: "t1", type: "tool", tool: "read", callID: "c1", state: { status: "running", input: { path: "README.md" } } }] } });
    expect(getRoom(room.id)!.messages.find((message) => message.id === turn.id)?.codeActivity).toContain("読取");

    // Once the request is no longer outstanding the activity line goes away and the listener is released.
    state.pendingRoom.mockReturnValue(undefined);
    emit({ type: "delta", message: null });
    expect(getRoom(room.id)!.messages.find((message) => message.id === turn.id)?.codeActivity).toBe("");
    expect(state.listeners.get("code-task")?.size ?? 0).toBe(0);
  });

  it("records why the exchange stopped so a paused room is not read as a finished one", async () => {
    const { room, bots, user } = setup();
    await runRoomConversation(room, bots, "残作業も進めて", user.id);
    expect(getRoom(room.id)?.lastOutcome).toEqual({ kind: "done", requestId: user.id });

    const next = appendRoomMessage(room.id, { role: "user", text: "もう一度" })!;
    state.pendingRoom.mockReturnValue(codeRequest(room, bots[0], { state: "running" }));
    await runRoomConversation(getRoom(room.id)!, bots, "もう一度", next.id);
    expect(getRoom(room.id)?.lastOutcome).toEqual({ kind: "code-wait", requestId: next.id });
  });

  it("waits only for its own conversation's Code request", async () => {
    const { room, bots, user } = setup();
    // A stale record from another request must not silence this one.
    state.pendingRoom.mockImplementation((_roomId: string, requestId: string) => requestId === user.id ? undefined : codeRequest(room, bots[0], { state: "ready" }));
    await runRoomConversation(room, bots, "残作業も進めて", user.id);
    expect(state.promptTask).toHaveBeenCalled();
    expect(getRoom(room.id)?.lastOutcome?.kind).toBe("done");
  });

  it("settles only long-abandoned working placeholders left by a crashed worker", () => {
    const { room } = setup();
    const stale = appendRoomMessage(room.id, { role: "assistant", botId: room.members[0], text: "", status: "working", createdAt: Date.now() - 10 * 60_000 })!;
    const live = appendRoomMessage(room.id, { role: "assistant", botId: room.members[1], text: "", status: "working" })!;
    expect(settleStaleRoomTurns(room.id)).toBe(1);
    const messages = getRoom(room.id)!.messages;
    expect(messages.find((message) => message.id === stale.id)).toMatchObject({ status: "error", text: "応答が中断されました。" });
    expect(messages.find((message) => message.id === live.id)?.status).toBe("working");
    expect(settleStaleRoomTurns(room.id)).toBe(0);
  });

  it("keeps a slow but still running turn untouched", () => {
    const { room, bots } = setup();
    const slow = appendRoomMessage(room.id, { role: "assistant", botId: bots[0].id, text: "", status: "working", createdAt: Date.now() - 10 * 60_000 })!;
    // Another worker is still updating this task record.
    patchTask(`bot:${bots[0].id}:room:${room.id}`, { status: "working" });
    expect(settleStaleRoomTurns(room.id)).toBe(0);
    expect(getRoom(room.id)!.messages.find((message) => message.id === slow.id)?.status).toBe("working");
  });

  it("does not let the same participant open every exchange", async () => {
    const { room, bots, user } = setup();
    await runRoomConversation(room, bots, "残作業も進めて", user.id);
    const first = state.promptTask.mock.calls[0][0];
    state.promptTask.mockClear();
    const next = appendRoomMessage(room.id, { role: "user", text: "もう一度" })!;
    await runRoomConversation(getRoom(room.id)!, bots, "もう一度", next.id);
    expect(state.promptTask.mock.calls[0][0]).not.toBe(first);
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
    state.pendingRoom.mockReturnValue(request);
    await runRoomConversation(room, bots, "残作業も進めて", request.room!.conversation.requestId);
    expect(getRoom(room.id)?.lastOutcome?.kind).toBe("code-wait");
    state.promptTask.mockClear();
    state.pendingRoom.mockReturnValue(undefined);
    expect(deliverRoomCodeReport(request, `修正を適用しテストは成功。\nROOM_ACTION: NEXT ${bots[1].id}`)).toBe(true);
    expect(getRoom(room.id)?.lastOutcome?.kind).toBe("done");
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

  it("waits for every queued Code report before resuming a conversation", async () => {
    const { room, bots } = setup();
    const first = codeRequest(room, bots[0], { id: "first" });
    const second = codeRequest(room, bots[1], {
      id: "second", botId: bots[1].id, originTaskId: `bot:${bots[1].id}:room:${room.id}`, codeTaskId: "code-2",
    });
    state.pendingRoom.mockReturnValue(first);
    await runRoomConversation(room, bots, "残作業も進めて", first.room!.conversation.requestId);
    expect(getRoom(room.id)?.lastOutcome?.kind).toBe("code-wait");

    state.pendingRoom.mockImplementation((_roomId, _requestId, excludeRequestId) => excludeRequestId === first.id ? second : undefined);
    state.promptTask.mockClear();
    expect(deliverRoomCodeReport(first, "最初の作業結果です")).toBe(true);
    expect(getRoom(room.id)?.lastOutcome?.kind).toBe("code-wait");
    await resumeRoomAfterCode(first);
    expect(state.promptTask).not.toHaveBeenCalled();

    expect(deliverRoomCodeReport(second, "二つ目の作業結果です")).toBe(true);
    expect(getRoom(room.id)?.lastOutcome?.kind).toBe("done");
    await resumeRoomAfterCode(second);
    expect(state.promptTask).toHaveBeenCalledTimes(1);
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
    expect(getRoom(room.id)!.messages.at(-1)!.text).toBe("外部へ");
    patchRoom(room.id, { members: [bots[1].id, outside.id] });
    expect(deliverRoomCodeReport({ ...request, id: "other" }, "結果\nROOM_ACTION: DONE")).toBe(false);
  });
});

describe("registered room handoffs", () => {
  function completedTurn(roomId: string, botId: string, requestId: string, members: string[]) {
    return appendRoomMessage(roomId, { role: "assistant", botId, botName: "turn", text: "依頼した", status: "done", conversation: { requestId, participantIds: members, turn: 1, maxTurns: 6 } })!;
  }

  it("delivers a waiting handoff after the report even though the speaker ended with DONE", async () => {
    const { room, bots, user } = setup(["A", "B"]);
    const request = codeRequest(room, bots[0], { state: "running" });
    state.pendingRoom.mockReturnValue(request);
    state.activeCodeRequests.set(request.id, request);
    await runRoomConversation(room, bots, "残作業も進めて", user.id);
    expect(getRoom(room.id)?.lastOutcome?.kind).toBe("code-wait");
    const turn = getRoom(room.id)!.messages.findLast((message) => message.botId === bots[0].id)!;
    registerRoomHandoff({
      roomId: room.id, requestId: user.id, fromMessageId: turn.id, fromBotId: bots[0].id,
      toBotId: bots[1].id, task: "完了後に競合テストを検証して", waitForCodeRequestId: request.id,
    });
    expect(getRoom(room.id)!.handoffs?.[0]).toMatchObject({ state: "waiting", toBotId: bots[1].id });

    state.promptTask.mockClear();
    state.pendingRoom.mockReturnValue(undefined);
    expect(deliverRoomCodeReport(request, "実装完了。\nROOM_ACTION: DONE")).toBe(true);
    await resumeRoomAfterCode(request);
    // The DONE speaker got no second turn; the handoff bot did, with the registered task.
    expect(state.promptTask).toHaveBeenCalledTimes(1);
    expect(state.promptTask.mock.calls[0][0]).toBe(`bot:${bots[1].id}:room:${room.id}`);
    expect(state.promptTask.mock.calls[0][1]).toContain("完了後に競合テストを検証して");
    expect(getRoom(room.id)!.handoffs?.[0]).toMatchObject({ state: "done" });
    expect(getRoom(room.id)!.messages.find((message) => message.id === turn.id)?.handoffs?.[0]).toMatchObject({ toBotName: "B", state: "done" });
  });

  it("delivers an immediate handoff instead of continuing the round-robin", async () => {
    const { room, bots, user } = setup(["A", "B"]);
    const taskA = `bot:${bots[0].id}:room:${room.id}`;
    state.promptTask.mockImplementation(async (id: string) => {
      if (id === taskA) {
        const working = getRoom(room.id)!.messages.findLast((message) => message.botId === bots[0].id && message.status === "working")!;
        registerRoomHandoff({ roomId: room.id, requestId: user.id, fromMessageId: working.id, fromBotId: bots[0].id, toBotId: bots[1].id, task: "すぐ検証して" });
      }
      const detail = state.details.get(id)!;
      detail.messages = [...detail.messages, assistant(`reply-${detail.messages.length}`, "進めた内容\nROOM_ACTION: DONE")];
    });
    await runRoomConversation(room, bots, "残作業も進めて", user.id);
    expect(state.promptTask.mock.calls.map((call) => call[0])).toEqual([taskA, `bot:${bots[1].id}:room:${room.id}`]);
    expect(state.promptTask.mock.calls[1][1]).toContain("すぐ検証して");
    expect(getRoom(room.id)!.handoffs?.[0]).toMatchObject({ state: "done" });
  });

  it("fails a handoff waiting on a Code request that did not succeed", async () => {
    const { room, bots, user } = setup(["A", "B"]);
    const turn = completedTurn(room.id, bots[0].id, user.id, room.members);
    const request = codeRequest(room, bots[0], { state: "running", result: JSON.stringify({ outcome: "失敗", error: "boom" }) });
    state.activeCodeRequests.set(request.id, request);
    registerRoomHandoff({
      roomId: room.id, requestId: user.id, fromMessageId: turn.id, fromBotId: bots[0].id,
      toBotId: bots[1].id, task: "完了後に検証して", waitForCodeRequestId: request.id,
    });
    await resumeRoomAfterCode(request);
    expect(state.promptTask).not.toHaveBeenCalled();
    expect(getRoom(room.id)!.handoffs?.[0]).toMatchObject({ state: "failed" });
  });

  it("returns the same receipt for replayed and equivalent registrations", () => {
    const { room, bots, user } = setup(["A", "B"]);
    const turn = completedTurn(room.id, bots[0].id, user.id, room.members);
    const base = { roomId: room.id, requestId: user.id, fromMessageId: turn.id, fromBotId: bots[0].id, toBotId: bots[1].id, task: "検証して" };
    expect(() => registerRoomHandoff({ ...base, toBotId: "誰か" })).toThrow();
    expect(() => registerRoomHandoff({ ...base, toBotId: bots[0].id })).toThrow();
    const first = registerRoomHandoff({ ...base, toolCallId: "call-1" });
    expect(registerRoomHandoff({ ...base, toolCallId: "call-1" })).toMatchObject({ duplicate: true, handoff: { id: first.handoff.id } });
    expect(registerRoomHandoff({ ...base, task: " 検証して  ", toolCallId: "call-2" })).toMatchObject({ duplicate: true, handoff: { id: first.handoff.id } });
    expect(getRoom(room.id)!.handoffs).toHaveLength(1);
  });

  it("cancels handoffs that have not started when the user stops", () => {
    const { room, bots, user } = setup(["A", "B"]);
    const turn = completedTurn(room.id, bots[0].id, user.id, room.members);
    const base = { roomId: room.id, requestId: user.id, fromMessageId: turn.id, fromBotId: bots[0].id };
    registerRoomHandoff({ ...base, toBotId: bots[1].id, task: "依頼1" });
    const waitingRequest = codeRequest(room, bots[0], { id: "wait-req" });
    state.activeCodeRequests.set(waitingRequest.id, waitingRequest);
    registerRoomHandoff({ ...base, toBotId: bots[1].id, task: "依頼2", waitForCodeRequestId: waitingRequest.id });
    expect(cancelPendingRoomHandoffs(room.id)).toBe(2);
    for (const handoff of getRoom(room.id)!.handoffs ?? []) expect(handoff.state).toBe("cancelled");
  });

  it("recovers after a restart: crashed runs fail, finished runs complete, unknown waits fail", () => {
    const { room, bots, user } = setup(["A", "B"]);
    const turn = completedTurn(room.id, bots[0].id, user.id, room.members);
    const base = { roomId: room.id, requestId: user.id, fromMessageId: turn.id, fromBotId: bots[0].id };
    const crashed = registerRoomHandoff({ ...base, toBotId: bots[1].id, task: "依頼1" }).handoff;
    const finished = registerRoomHandoff({ ...base, toBotId: bots[1].id, task: "依頼2" }).handoff;
    // A waiting handoff whose Code request file disappeared since registration (restart cleanup).
    const waiting: RoomHandoff = { id: "waiting-1", requestId: user.id, fromMessageId: turn.id, fromBotId: bots[0].id, toBotId: bots[1].id, task: "依頼3", waitForCodeRequestId: "b".repeat(64), state: "waiting", createdAt: Date.now(), updatedAt: Date.now() };
    updateRoomHandoffs(room.id, (handoffs) => [...handoffs, waiting]);
    const crashedMessage = appendRoomMessage(room.id, { role: "assistant", botId: bots[1].id, text: "", status: "working" })!;
    const finishedMessage = appendRoomMessage(room.id, { role: "assistant", botId: bots[1].id, text: "検証した", status: "done" })!;
    updateRoomHandoffs(room.id, (handoffs) => handoffs.map((handoff) => {
      if (handoff.id === crashed.id) return { ...handoff, state: "running", responseMessageId: crashedMessage.id };
      if (handoff.id === finished.id) return { ...handoff, state: "running", responseMessageId: finishedMessage.id };
      return handoff;
    }));
    updateRoomMessage(room.id, crashedMessage.id, { status: "error" });
    expect(settleRoomHandoffs(room.id)).toBe(0);
    const states = Object.fromEntries((getRoom(room.id)!.handoffs ?? []).map((handoff) => [handoff.id, handoff]));
    expect(states[crashed.id]).toMatchObject({ state: "failed" });
    expect(states[finished.id]).toMatchObject({ state: "done" });
    expect(states[waiting.id]).toMatchObject({ state: "failed" });
  });
});
