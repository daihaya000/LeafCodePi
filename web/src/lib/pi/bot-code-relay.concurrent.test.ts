import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotDto, TaskSummary, UiMessage } from "@/lib/types";

const store = vi.hoisted(() => ({ root: "", bots: new Map<string, BotDto>(), tasks: new Map<string, TaskSummary>() }));
vi.mock("@/lib/paths", () => ({ dataDir: () => store.root }));
vi.mock("@/lib/bots", () => ({
  getBot: (id: string) => store.bots.get(id),
  patchBot: (id: string, patch: Partial<BotDto>) => Object.assign(store.bots.get(id)!, patch),
}));
vi.mock("@/lib/store", () => ({
  getTask: (id: string) => store.tasks.get(id),
  getProject: () => ({ id: "project", name: "Project" }),
  listProjects: () => [{ id: "project", name: "Project" }],
}));
import { appendRoomMessage, createRoom, getRoom, roomBotTaskId } from "@/lib/rooms";
import { createBotCodeRelay, stopBotCodeRequest, type CodeRequest } from "./bot-code-relay";

type Dependencies = Parameters<typeof createBotCodeRelay>[0];
let deps: Dependencies;
let relay: ReturnType<typeof createBotCodeRelay>;
let roomId: string;
let roomOrigin: string;
const output = new Map<string, string>();
function task(id: string, extra: Partial<TaskSummary> = {}): TaskSummary { return { id, status: "idle", projectId: "project", ...extra } as TaskSummary; }
function records(): CodeRequest[] {
  const dir = join(store.root, "bot-code-requests");
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as CodeRequest);
}
function start(origin: string, call: string) { return relay.run(origin, call, { action: "start", projectId: "project", prompt: call }, "session"); }

beforeEach(() => {
  store.root = mkdtempSync(join(tmpdir(), "code-concurrent-"));
  store.bots.clear(); store.tasks.clear(); output.clear();
  store.bots.set("one", { id: "one", name: "One", enabled: true, permissionMode: "ask" } as BotDto);
  store.tasks.set("bot:one", task("bot:one", { kind: "bot", botId: "one" }));
  const room = createRoom({ members: ["one"] });
  roomId = room.id; roomOrigin = roomBotTaskId(roomId, "one");
  store.tasks.set(roomOrigin, task(roomOrigin, { kind: "bot", botId: "one" }));
  const user = appendRoomMessage(roomId, { role: "user", text: "Independent changes" })!;
  appendRoomMessage(roomId, { id: "response", role: "assistant", botId: "one", text: "", status: "working", conversation: { requestId: user.id, participantIds: ["one"], turn: 1, maxTurns: 4 } });
  let next = 0;
  deps = {
    create: vi.fn(async (input) => {
      const code = task(`code-${++next}`, { status: "working" });
      store.tasks.set(code.id, code); input.beforePrompt(code); return code;
    }),
    prompt: vi.fn(async (id) => { store.tasks.get(id)!.status = "working"; return store.tasks.get(id)!; }),
    abort: vi.fn(async (id) => { store.tasks.get(id)!.status = "idle"; return store.tasks.get(id)!; }),
    approve: vi.fn(async () => true),
    isBusy: (id) => store.tasks.get(id)?.status === "working",
    goalLoop: () => null,
    messages: async (code) => [{ id: code.id, role: "assistant", parts: [{ type: "text", text: output.get(code.id) ?? code.id }] }] as UiMessage[],
    deliver: vi.fn(async () => true),
  };
  relay = createBotCodeRelay(deps);
});
afterEach(() => { relay.dispose(); rmSync(store.root, { recursive: true, force: true }); });

it.each(["Bot", "Room"])("starts two %s requests before the first launch finishes and keeps receipts separate", async (mode) => {
  const origin = mode === "Room" ? roomOrigin : "bot:one";
  const create = deps.create;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  deps.create = vi.fn(async (input) => { if (input.prompt === "first") await held; return create(input); });
  const first = start(origin, "first");
  const second = start(origin, "second");
  let scan: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(deps.create).toHaveBeenCalledTimes(2));
    await expect(second).resolves.toMatchObject({ state: "running", taskId: "code-1" });
    scan = relay.tick(); // A startup scan must not turn the held launch into a failed request.
  } finally { release(); }
  const [a, b] = await Promise.all([first, second]);
  await scan;
  expect(a.requestId).not.toBe(b.requestId);
  expect(records().every((request) => request.state === "running")).toBe(true);
  expect(relay.codeTasksForOrigin(origin).sort()).toEqual(["code-1", "code-2"]);
  await start(origin, "first");
  expect(deps.create).toHaveBeenCalledTimes(2);
  if (mode === "Room") {
    const cards = getRoom(roomId)!.messages.at(-1)!.codeRequests!;
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.taskId).sort()).toEqual(["code-1", "code-2"]);
  }
});

it.each(["Bot", "Room"])("controls the exact older %s session and rejects a foreign conversation", async (mode) => {
  const origin = mode === "Room" ? roomOrigin : "bot:one";
  await start(origin, "first"); await start(origin, "second");
  await expect(relay.run(origin, "status", { action: "status", taskId: "code-1" }, "session")).resolves.toMatchObject({ task: { id: "code-1" } });
  await expect(relay.run(origin, "busy", { action: "prompt", taskId: "code-1", prompt: "follow-up" }, "session")).rejects.toThrow("busy");
  await relay.run(origin, "abort", { action: "abort", taskId: "code-1" }, "session");
  expect(store.tasks.get("code-2")!.status).toBe("working");
  await relay.complete(records().find((request) => request.codeTaskId === "code-1")!.id);
  await relay.run(origin, "follow", { action: "prompt", taskId: "code-1", prompt: "follow-up" }, "session");
  expect(deps.prompt).toHaveBeenCalledWith("code-1", "follow-up", expect.any(String));
  const foreign = mode === "Room" ? "bot:one" : roomOrigin;
  for (const action of ["status", "abort", "prompt"] as const) {
    await expect(relay.run(foreign, action, { action, taskId: "code-1", prompt: "wrong" }, "session")).rejects.toThrow("does not belong");
  }
});

it("captures a sibling result while another report is still being delivered", async () => {
  await start("bot:one", "first"); await start("bot:one", "second");
  store.tasks.get("code-1")!.status = "idle";
  output.set("code-1", "first output"); output.set("code-2", "second output");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(deps.deliver).mockImplementationOnce(async () => { await held; return true; });
  const scan = relay.tick();
  try {
    await vi.waitFor(() => expect(deps.deliver).toHaveBeenCalledTimes(1));
    await relay.complete(records().find((request) => request.codeTaskId === "code-2")!.id);
    output.set("code-2", "unrelated later output");
    expect(records().find((request) => request.codeTaskId === "code-2")!.result).toContain("second output");
  } finally { release(); await scan; }
  await relay.tick();
  expect(records().every((request) => request.state === "delivered")).toBe(true);
  expect(deps.deliver).toHaveBeenCalledTimes(2);
  expect(records().find((request) => request.codeTaskId === "code-1")!.result).toContain("first output");
});

it("recovers all old approved queue entries alongside a running Room request", async () => {
  await start(roomOrigin, "first");
  const original = records()[0];
  for (const digit of ["a", "b"]) {
    const pending: CodeRequest = { ...original, id: digit.repeat(64), state: "queued", codeTaskId: null, prompt: `old-${digit}` };
    writeFileSync(join(store.root, "bot-code-requests", `${pending.id}.json`), JSON.stringify(pending), "utf8");
  }
  await relay.tick();
  expect(deps.create).toHaveBeenCalledTimes(3);
  expect(deps.approve).toHaveBeenCalledTimes(1);
  expect(records().every((request) => request.state === "running")).toBe(true);
  const cards = getRoom(roomId)!.messages.at(-1)!.codeRequests!;
  expect(cards).toHaveLength(3);
  expect(new Set(cards.map((card) => card.taskId)).size).toBe(3);
  const stopped = await stopBotCodeRequest("one", original.id);
  expect(stopped?.codeTaskId).toBe("code-1");
  expect(records().filter((request) => request.stoppedByUser)).toHaveLength(1);
  expect(store.tasks.get("code-2")!.status).toBe("working");
});
