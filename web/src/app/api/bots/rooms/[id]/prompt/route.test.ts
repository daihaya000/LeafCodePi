import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, UiMessage } from "@/lib/types";

const state = vi.hoisted(() => ({
  root: "",
  details: new Map<string, TaskDetail>(),
  listeners: new Map<string, Set<(payload: Record<string, unknown>) => void>>(),
  completions: new Map<string, () => void>(),
  promptTask: vi.fn(),
  abortTask: vi.fn(),
}));
vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  dataDir: () => state.root,
  storePath: () => join(state.root, "store.json"),
}));
vi.mock("@/lib/pi/harness", () => ({
  getTaskDetail: vi.fn(async (id: string) => state.details.get(id)),
  promptTask: state.promptTask,
  abortTask: state.abortTask,
  pendingPermissionForTask: vi.fn(() => null),
  pendingQuestionForTask: vi.fn(() => null),
  subscribeTask: (id: string, listener: (payload: Record<string, unknown>) => void) => {
    const listeners = state.listeners.get(id) ?? new Set();
    state.listeners.set(id, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  jsonError: (error: Error) => ({ error: error.message, status: 500 }),
}));

import { botTaskId, createBot, patchBot } from "@/lib/bots";
import * as rooms from "@/lib/rooms";
import { createRoom, ensureRoomBotTask, getRoom, patchRoom } from "@/lib/rooms";
import { getTaskDetail } from "@/lib/pi/harness";
import { getTask } from "@/lib/store";
import { GET as events } from "../events/route";
import { POST } from "./route";
import { PATCH } from "../route";

function snapshot(taskId: string, eventType: string, patch: Partial<TaskDetail>) {
  const detail = { ...state.details.get(taskId)!, ...patch };
  state.details.set(taskId, detail);
  for (const listener of state.listeners.get(taskId) ?? []) {
    listener({ type: "snapshot", task: detail, ...detail, eventType });
  }
}
function finish(taskId: string, patch: Partial<TaskDetail> = {}) {
  snapshot(taskId, "agent_settled", { status: "idle", isStreaming: false, isCompacting: false, ...patch });
  const resolve = state.completions.get(taskId);
  state.completions.delete(taskId);
  resolve?.();
}
function assistant(id: string, text: string): UiMessage {
  return { id, role: "assistant", createdAt: Date.now(), parts: [{ id: `${id}-text`, type: "text", text }] };
}
function send(id: string, prompt: string, extra: Record<string, unknown> = {}) {
  return POST(new NextRequest("http://localhost", { method: "POST", body: JSON.stringify({ prompt, ...extra }) }), { params: Promise.resolve({ id }) });
}
function setup(names = ["A"]) {
  const bots = names.map((name) => createBot({ name }));
  const room = createRoom({ members: bots.map((bot) => bot.id) });
  const taskIds = bots.map((bot) => ensureRoomBotTask(room, bot));
  for (const id of taskIds) state.details.set(id, { ...getTask(id)!, messages: [], isStreaming: false, isCompacting: false });
  return { room, bots, taskIds };
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "leafcode-room-prompt-"));
  state.promptTask.mockImplementation(async (id: string, _prompt: string, _images: unknown, options?: { waitForCompletion?: boolean }) => {
    snapshot(id, "prompt_accepted", { status: "working", isStreaming: false, error: null });
    if (options?.waitForCompletion) {
      await new Promise<void>((resolve) => state.completions.set(id, resolve));
    }
    return state.details.get(id);
  });
});
afterEach(async () => {
  for (const id of state.completions.keys()) finish(id);
  await new Promise((resolve) => setImmediate(resolve));
  rmSync(state.root, { recursive: true, force: true });
  state.details.clear();
  state.listeners.clear();
  state.promptTask.mockReset();
  state.abortTask.mockReset();
  vi.restoreAllMocks();
});

describe("room mention responses", () => {
  it.each(["二人で会話してみて", "@here 二人で会話してみて", "@Debugger @Planner 二人で会話してみて", "/discuss 学ぶ言語を話し合って", "残作業も進めて"])("gives each participant one turn with shared identities and replies when no directive is used: %s", async (request) => {
    const { room, bots, taskIds } = setup(["Debugger", "Planner"]);
    await send(room.id, request);
    for (let turn = 0; turn < 2; turn += 1) {
      await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(turn + 1));
      const [taskId, prompt] = state.promptTask.mock.calls[turn];
      expect(taskId).toBe(taskIds[turn % 2]);
      expect(prompt).toContain(`Your identity: ${JSON.stringify({ name: bots[turn % 2].name, id: bots[turn % 2].id })}`);
      expect(prompt).toContain("Debugger");
      expect(prompt).toContain("Planner");
      if (turn > 0) expect(prompt).toContain(`Contribution ${turn - 1}`);
      expect(prompt).toContain("never simulate their replies");
      expect(prompt).toContain("at most about three short sentences");
      finish(taskId, { messages: [...state.details.get(taskId)!.messages, assistant(`turn-${turn}`, `Contribution ${turn}`)] });
    }
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.filter((message) => message.status === "done")).toHaveLength(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.promptTask).toHaveBeenCalledTimes(2);
  });

  it("keeps a large room legible by limiting one exchange to six voices", async () => {
    const { room, bots } = setup(["A", "B", "C", "D", "E", "F", "G", "H"]);
    const result = await (await send(room.id, "残作業も進めて")).json();
    // The response names the voices that will actually speak, not every member.
    expect(result.routedBotIds).toEqual(bots.slice(0, 6).map((member) => member.id));
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalled());
    for (let turn = 0; turn < 6; turn += 1) {
      await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(turn + 1));
      const [taskId, prompt] = state.promptTask.mock.calls[turn];
      const roster = JSON.parse(prompt.split("Participants (id, name, role): ")[1].split("\n")[0]);
      expect(roster.map((member: { id: string }) => member.id)).toEqual(bots.slice(0, 6).map((member) => member.id));
      finish(taskId, { messages: [...state.details.get(taskId)!.messages, assistant(`cap-${turn}`, `意見 ${turn}`)] });
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.promptTask).toHaveBeenCalledTimes(6);
  });

  it("ends immediately on DONE without dragging in a silent participant", async () => {
    const { room, bots, taskIds } = setup(["A", "B", "C"]);
    let turn = 0;
    state.promptTask.mockImplementation(async (id: string) => {
      const text = turn === 0 ? `仕様が不明確です。\nROOM_ACTION: NEXT ${bots[1].id}` : "具体的な対象を教えてください。\nROOM_ACTION: DONE 指示をお待ちしています。";
      snapshot(id, "agent_settled", { messages: [assistant(`done-${turn++}`, text)] });
    });
    await send(room.id, "Test");
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.filter((message) => message.status === "done")).toHaveLength(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.promptTask.mock.calls.map(([id]) => id)).toEqual([taskIds[0], taskIds[1]]);
    const last = getRoom(room.id)!.messages.at(-1)!;
    expect(last.text).toBe("具体的な対象を教えてください。\n指示をお待ちしています。");
  });

  it("hands the floor to the requested participant and ends after a substantive conclusion", async () => {
    const { room, bots, taskIds } = setup(["A", "B", "C"]);
    const texts = [
      `C, what is the main risk?\nROOM_ACTION: NEXT ${bots[2].id}`,
      `The main risk is cost. B, how can we reduce it?\nROOM_ACTION: NEXT ${bots[1].id}`,
      "Use the existing service. Agreed next step: measure its cost.\nROOM_ACTION: DONE",
    ];
    let turn = 0;
    state.promptTask.mockImplementation(async (id: string) => {
      snapshot(id, "agent_settled", { messages: [assistant(`turn-${turn}`, texts[turn++])] });
    });
    await send(room.id, "/discuss Compare the options");
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.filter((message) => message.status === "done")).toHaveLength(3));
    expect(state.promptTask.mock.calls.map(([id]) => id)).toEqual([taskIds[0], taskIds[2], taskIds[1]]);
    expect(state.promptTask.mock.calls[1][1]).toContain("C, what is the main risk?");
    expect(getRoom(room.id)?.messages.filter((message) => message.role === "assistant").every((message) => !message.text.includes("ROOM_ACTION"))).toBe(true);
  });

  it.each([2, 5])("caps handoffs for %s participants even when bots never finish", async (count) => {
    const { room, bots, taskIds } = setup(Array.from({ length: count }, (_, i) => `Bot${i}`));
    const limit = Math.min(8, count * 2);
    let turn = 0;
    state.promptTask.mockImplementation(async (id: string) => {
      const next = (taskIds.indexOf(id) + 1) % count;
      const text = `New point ${turn++}\nROOM_ACTION: NEXT ${bots[next].id}`;
      snapshot(id, "agent_settled", { messages: [assistant(`turn-${turn}`, text)] });
    });
    await send(room.id, "/discuss Options");
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.filter((message) => message.status === "done")).toHaveLength(limit));
    expect(state.promptTask).toHaveBeenCalledTimes(limit);
    expect(state.promptTask.mock.calls.at(-1)?.[1]).toContain("This is the final available turn");
  });

  it("stops repeated contributions rather than spending the handoff budget", async () => {
    const { room, bots, taskIds } = setup(["A", "B"]);
    let turn = 0;
    state.promptTask.mockImplementation(async (id: string) => {
      const next = id === taskIds[0] ? bots[1] : bots[0];
      snapshot(id, "agent_settled", { messages: [assistant(`repeat-${turn++}`, `Same point\nROOM_ACTION: NEXT ${next.id}`)] });
    });
    await send(room.id, "/discuss Options");
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.filter((message) => message.status === "done")).toHaveLength(3));
    expect(state.promptTask).toHaveBeenCalledTimes(3);
  });

  it("does not hand off to a room member outside the user's selected participants", async () => {
    const { room, bots, taskIds } = setup(["A", "B", "C"]);
    let turn = 0;
    state.promptTask.mockImplementation(async (id: string) => {
      const text = id === taskIds[0] ? `Ask C\nROOM_ACTION: NEXT ${bots[2].id}` : "The two of us are done.\nROOM_ACTION: DONE";
      snapshot(id, "agent_settled", { messages: [assistant(`scope-${turn++}`, text)] });
    });
    await send(room.id, "/discuss @A @B Compare options");
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.filter((message) => message.status === "done")).toHaveLength(2));
    expect(state.promptTask.mock.calls.map(([id]) => id)).toEqual(taskIds.slice(0, 2));
  });

  it("starts at most four independent replies at once and drains the rest", async () => {
    const { room, taskIds } = setup(["A", "B", "C", "D", "E", "F"]);
    await send(room.id, "@here 状況を教えて");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.promptTask).toHaveBeenCalledTimes(4);

    const started = state.promptTask.mock.calls.map(([id]) => id as string);
    finish(started[0], { messages: [assistant("a", "A reply")] });
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(5));
    finish(started[1], { messages: [assistant("b", "B reply")] });
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(6));
    expect(new Set(state.promptTask.mock.calls.map(([id]) => id)).size).toBe(taskIds.length);
  });

  it("redirects the turn already being written instead of queuing a second one for that bot", async () => {
    const { room, bots, taskIds } = setup(["A", "B"]);
    await send(room.id, "@A first");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(1));

    const result = await (await send(room.id, "@A second")).json();
    expect(result.steeredBotIds).toEqual([bots[0].id]);
    expect(result.routedBotIds).toEqual([]);
    // The running turn receives the new instruction; no extra turn is queued for that bot.
    expect(state.promptTask).toHaveBeenCalledTimes(2);
    expect(state.promptTask.mock.calls[1][1]).toContain("@A second");
    expect(state.promptTask.mock.calls[1][3]).toMatchObject({ streamingBehavior: "steer" });

    finish(taskIds[0], { messages: [assistant("first", "Redirected reply")] });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.filter((message) => message.status === "done")).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.promptTask).toHaveBeenCalledTimes(2);
  });

  it("still starts a turn for a bot that is not currently writing", async () => {
    const { room, bots, taskIds } = setup(["A", "B"]);
    await send(room.id, "@A first");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(1));
    const result = await (await send(room.id, "@B please help")).json();
    expect(result.steeredBotIds).toEqual([bots[0].id]);
    expect(result.routedBotIds).toEqual([bots[1].id]);
    await vi.waitFor(() => expect(state.promptTask.mock.calls.map(([id]) => id)).toContain(taskIds[1]));
  });

  it("stops the turns being written when the user says stop", async () => {
    const { room, taskIds } = setup(["A", "B"]);
    await send(room.id, "@here Earlier work");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(2));
    const result = await (await send(room.id, "/stop")).json();
    expect(result).toMatchObject({ stopped: true, stoppedTurns: 2 });
    expect(state.abortTask.mock.calls.map(([id]) => id).sort()).toEqual([...taskIds].sort());
    // Stopping never steers: the interrupted turns must not receive the stop text as an instruction.
    expect(state.promptTask).toHaveBeenCalledTimes(2);
  });

  it("does not execute a superseded conversation after waiting in the bot queue", async () => {
    const { room, taskIds } = setup(["A", "B"]);
    // Both room sessions are busy, so the discussion can only start after the queue drains.
    await send(room.id, "@here Earlier work");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(2));
    await send(room.id, "/discuss Options");
    await send(room.id, "/stop");
    for (const taskId of taskIds) finish(taskId, { messages: [assistant(`earlier-${taskId}`, "Earlier reply")] });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.filter((message) => message.status === "working")).toHaveLength(0));
    // Both busy bots were steered by /discuss, so no third turn started for the superseded request.
    expect(state.promptTask).toHaveBeenCalledTimes(4);
    expect(getRoom(room.id)?.messages.some((message) => message.text.includes("superseded"))).toBe(false);
  });

  it.each(["superseded", "disabled"])("revalidates a %s turn after asynchronous task preparation", async (change) => {
    const { room, bots, taskIds } = setup(["A", "B"]);
    let release!: (detail: TaskDetail) => void;
    vi.mocked(getTaskDetail).mockImplementationOnce(() => new Promise<TaskDetail>((resolve) => { release = resolve; }));
    await send(room.id, "/discuss Options");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    if (change === "superseded") await send(room.id, "/stop");
    else patchBot(bots[0].id, { enabled: false });
    release(state.details.get(taskIds[0])!);
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.filter((message) => message.status === "working")).toHaveLength(0));
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it("does not interpret normal replies as room control instructions", async () => {
    const { room, bots, taskIds } = setup(["A", "B"]);
    await send(room.id, "@A Explain the room protocol");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(1));
    const text = `Example directive\nROOM_ACTION: NEXT ${bots[1].id}`;
    finish(taskIds[0], { messages: [assistant("ordinary", text)] });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.at(-1)).toMatchObject({ status: "done", text }));
    expect(state.promptTask).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "removed"])("does not prompt a participant that was %s during the previous turn", async (change) => {
    const { room, bots, taskIds } = setup(["A", "B"]);
    await send(room.id, "/discuss Options");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(1));
    if (change === "disabled") patchBot(bots[1].id, { enabled: false });
    else patchRoom(room.id, { members: [bots[0].id] });
    finish(taskIds[0], { messages: [assistant("reply", `B?\nROOM_ACTION: NEXT ${bots[1].id}`)] });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.filter((message) => message.status === "working")).toHaveLength(0));
    expect(state.promptTask).toHaveBeenCalledTimes(1);
  });

  it("stops the conversation when a newer user message arrives", async () => {
    const { room, taskIds } = setup(["A", "B"]);
    await send(room.id, "二人で会話してみて");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(1));
    await send(room.id, "止めて");
    finish(taskIds[0], { messages: [assistant("first", "First reply")] });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.find((message) => message.role === "assistant")?.status).toBe("done"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.promptTask).toHaveBeenCalledTimes(1);
  });

  it.each(["@here", "@channel", "@everyone", "@all", "@A"])("waits for the actual reply to %s, not an idle-looking snapshot", async (mention) => {
    const { room, taskIds: [taskId] } = setup();
    expect((await send(room.id, `${mention} Test`)).status).toBe(200);
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(1));
    expect(getRoom(room.id)?.messages.at(-1)?.status).toBe("working");
    snapshot(taskId, "provider_routed", { status: "working", isStreaming: false });
    snapshot(taskId, "compaction_start", { status: "idle", isStreaming: false, isCompacting: true });
    snapshot(taskId, "agent_end", { isCompacting: false, messages: [assistant("intermediate", "Still continuing")] });
    expect(getRoom(room.id)?.messages.at(-1)?.status).toBe("working");
    finish(taskId, { messages: [assistant("reply", "こんにちは 🌿")] });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.at(-1)).toMatchObject({ status: "done", text: "こんにちは 🌿" }));
    expect(state.listeners.get(taskId)?.size ?? 0).toBe(0);
  });

  it("matches consecutive prompts to their own replies, even at the same timestamp", async () => {
    const { room, taskIds: [taskId] } = setup();
    await send(room.id, "@A first");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(1));
    const first = assistant("first", "First reply");
    const second = { ...assistant("second", "Second reply"), createdAt: first.createdAt };
    finish(taskId, { messages: [first] });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.at(-1)).toMatchObject({ status: "done", text: "First reply" }));

    await send(room.id, "@A second");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(2));
    expect(getRoom(room.id)?.messages.filter((message) => message.role === "assistant")).toMatchObject([
      { status: "done", text: "First reply" }, { status: "working", text: "" },
    ]);
    finish(taskId, { messages: [first, second] });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.at(-1)).toMatchObject({ status: "done", text: "Second reply" }));
  });

  it("does not reuse a recent reply when the next prompt returns no assistant", async () => {
    const { room, taskIds: [taskId] } = setup();
    const old = assistant("old", "Previous reply");
    state.details.get(taskId)!.messages = [old];
    await send(room.id, "@A next");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(1));
    finish(taskId);
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.at(-1)).toMatchObject({ status: "error", text: "Bot did not return a response." }));
  });

  it("runs broadcast members independently and never uses their 1:1 tasks", async () => {
    const { room, bots, taskIds } = setup(["A", "B"]);
    await send(room.id, "@here Test");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(2));
    expect(state.promptTask.mock.calls.map(([id]) => id).sort()).toEqual([...taskIds].sort());
    expect(taskIds).not.toContain(botTaskId(bots[0].id));
    finish(taskIds[1], { messages: [assistant("b", "B reply")] });
    finish(taskIds[0], { status: "error", error: "Provider unavailable" });
    await vi.waitFor(() => {
      const replies = getRoom(room.id)?.messages.filter((message) => message.role === "assistant") ?? [];
      expect(replies.find((message) => message.botId === bots[0].id)).toMatchObject({ status: "error", text: "Provider unavailable" });
      expect(replies.find((message) => message.botId === bots[1].id)).toMatchObject({ status: "done", text: "B reply" });
    });
  });

  it("does not serialize the same bot across different rooms", async () => {
    const { room, bots: [bot], taskIds: [firstTask] } = setup();
    const other = createRoom({ members: [bot.id] });
    const otherTask = ensureRoomBotTask(other, bot);
    state.details.set(otherTask, { ...getTask(otherTask)!, messages: [], isStreaming: false, isCompacting: false });
    await send(room.id, "@A first room");
    await send(other.id, "@A second room");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(2));
    finish(firstTask, { messages: [assistant("first", "First room")] });
    finish(otherTask, { messages: [assistant("other", "Other room")] });
    await vi.waitFor(() => expect(getRoom(other.id)?.messages.at(-1)?.text).toBe("Other room"));
    expect(getRoom(room.id)?.messages.at(-1)?.text).toBe("First room");
  });

  it.each(["empty", "assistant error", "task error"])("reports %s instead of marking a blank or failed reply done", async (kind) => {
    const { room, taskIds: [taskId] } = setup();
    await send(room.id, "@A Test");
    await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(1));
    const reply = assistant("reply", kind === "empty" ? " \n" : "Partial response");
    if (kind === "assistant error") reply.error = "Provider failed";
    finish(taskId, { messages: [reply], ...(kind === "task error" ? { status: "error", error: "Provider failed" } : {}) });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.at(-1)).toMatchObject({ status: "error", text: kind === "empty" ? "Bot did not return a response." : "Provider failed" }));
  });

  it.each(["setup", "initialization", "prompt"])("isolates a %s failure and releases the queue for the next mention", async (phase) => {
    const { room, taskIds: [taskId] } = setup();
    if (phase === "setup") vi.spyOn(rooms, "ensureRoomBotTask").mockImplementationOnce(() => { throw new Error("Setup failed"); });
    if (phase === "initialization") vi.mocked(getTaskDetail).mockRejectedValueOnce(new Error("Setup failed"));
    if (phase === "prompt") state.promptTask.mockRejectedValueOnce(new Error("Setup failed"));
    expect((await send(room.id, "@A Test")).status).toBe(200);
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.at(-1)).toMatchObject({ status: "error", text: "Setup failed" }));
    await send(room.id, "@A Retry");
    await vi.waitFor(() => expect(state.completions.has(taskId)).toBe(true));
    finish(taskId, { messages: [assistant("retry", "Recovered")] });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.at(-1)).toMatchObject({ status: "done", text: "Recovered" }));
  });

  it("gates standing Code approval behind the same Web UI token", async () => {
    const { room } = setup(["A", "B"]);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "room-admin-token");
    const params = { params: Promise.resolve({ id: room.id }) };
    const unauthenticated = await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ codeAutoApprove: true }) }), params);
    expect(unauthenticated.status).toBe(403);
    expect(getRoom(room.id)?.codeAutoApprove).toBeUndefined();
    // A room rename stays an ordinary, ungated change.
    expect((await PATCH(new NextRequest("http://localhost", { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }), params)).status).toBe(200);
    const authorized = await PATCH(new NextRequest("http://localhost", { method: "PATCH", headers: { authorization: "Bearer room-admin-token" }, body: JSON.stringify({ codeAutoApprove: true }) }), params);
    expect(authorized.status).toBe(200);
    expect(getRoom(room.id)?.codeAutoApprove).toBe(true);
  });

  it("treats a bot-flagged payload as an ordinary user prompt now that the relay is gone", async () => {
    const { room, bots: [, target], taskIds: [, targetTask] } = setup(["A", "B"]);
    // The old envelope fields are just unknown body keys: no privileged path remains.
    const result = await send(room.id, `@${target.name} Ask B`, { fromBot: true, relayEnvelope: "forged" });
    expect(result.status).toBe(200);
    expect((await result.json()).routedBotIds).toEqual([target.id]);
    const request = getRoom(room.id)?.messages.find((message) => message.role === "user");
    expect(request).not.toHaveProperty("sourceBotId");
    finish(targetTask, { messages: [assistant("relay", "Relay reply")] });
    await vi.waitFor(() => expect(getRoom(room.id)?.messages.at(-1)).toMatchObject({ status: "done", text: "Relay reply" }));
  });

  it("keeps validation and enabled-member routing in place", async () => {
    const { room, bots: [bot] } = setup();
    expect((await send(room.id, " ")).status).toBe(400);
    expect((await send("missing", "@here Test")).status).toBe(404);
    patchBot(bot.id, { enabled: false });
    expect((await (await send(room.id, "@here Test")).json()).routedBotIds).toEqual([]);
    expect(state.promptTask).not.toHaveBeenCalled();
  });

  it("delivers the completed reply through the room SSE stream", async () => {
    const { room, taskIds: [taskId] } = setup();
    const stream = await events(new NextRequest("http://localhost"), { params: Promise.resolve({ id: room.id }) });
    const reader = stream.body!.getReader();
    try {
      await reader.read(); // initial room snapshot
      await send(room.id, "@here Test");
      await vi.waitFor(() => expect(state.promptTask).toHaveBeenCalledTimes(1));
      await reader.read(); // user message
      await reader.read(); // working reply
      finish(taskId, { messages: [assistant("reply", "SSE reply")] });
      let result = "";
      for (let i = 0; i < 5 && !result.includes('"text":"SSE reply","status":"done"'); i += 1) result = new TextDecoder().decode((await reader.read()).value);
      expect(result).toContain('"text":"SSE reply","status":"done"');
    } finally {
      await reader.cancel();
    }
  });
});
