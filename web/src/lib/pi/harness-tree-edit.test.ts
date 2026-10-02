import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { insertTask, upsertProject, getTask, patchTask } from "@/lib/store";
import { beginTaskPreparation } from "./task-operation-guard";
import { abortTask, compactTask, goalLoopCommand, isTaskRuntimeBusyForDestructiveEdit, promptTask, revertTask, setTaskAgent, setTaskModel, setTaskThinkingLevel, unrevertTask } from "./harness";
const globals = globalThis as Record<string, unknown>;
let root: string;
let previous: unknown;
let id: string;
let leaf: string | null;
let runtime: Record<string, unknown>;
let session: ReturnType<typeof makeSession>;
const entries = [
  { type: "message", id: "early", parentId: null, message: { role: "user", content: "first" } },
  { type: "message", id: "late", parentId: "early", message: { role: "user", content: "second" } },
  { type: "message", id: "tip", parentId: "late", message: { role: "assistant", content: "answer" } },
];
function makeSession() {
  return {
    sessionId: "test-session", isStreaming: false, isCompacting: false,
    messages: [], agent: { state: { messages: [] } }, prompt: vi.fn(), abort: vi.fn(), clearQueue: vi.fn(),
    compact: vi.fn(), setThinkingLevel: vi.fn(),
    extensionRunner: { getCommand: vi.fn<() => { handler: () => void } | undefined>(), createCommandContext: () => ({}) },
    sessionManager: {
      getEntries: () => entries, getBranch: () => entries, getCwd: () => root, getLeafId: () => leaf,
      getEntry: (entryId: string) => entries.find((entry) => entry.id === entryId),
      branch: (entryId: string) => { leaf = entryId; }, buildSessionContext: () => ({ messages: [] }),
    },
    navigateTree: vi.fn(async (entryId: string) => {
      const entry = entries.find((item) => item.id === entryId)!;
      leaf = entry.parentId;
      return { cancelled: false, aborted: false, editorText: entry.message.content };
    }),
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-tree-edit-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  previous = globals.__leafcodePiHarness;
  const project = upsertProject({ name: "test", rootPath: root });
  id = insertTask({ project, title: "tree edit" }).id;
  leaf = "tip"; session = makeSession();
  runtime = { taskId: id, session, accountId: null, agentName: null, promptEpoch: 0, promptChain: Promise.resolve(),
    accountByMessageId: new Map(), agentByMessageId: new Map(), throughputByStartedAt: new Map(),
    toolStartedAt: new Map(), toolEndedAt: new Map(), toolPartialOutputByCallId: new Map() };
  globals.__leafcodePiHarness = { events: new EventEmitter(), live: new Map([[id, runtime]]) };
});
afterEach(() => {
  if (previous === undefined) delete globals.__leafcodePiHarness; else globals.__leafcodePiHarness = previous;
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
it("a pending preparer blocks destructive replacement and Goal resume", async () => {
  const preparation = beginTaskPreparation(id);
  try {
    expect(isTaskRuntimeBusyForDestructiveEdit(id)).toBe(true);
    await expect(goalLoopCommand(id, { action: "resume" })).rejects.toMatchObject({ status: 409 });
  } finally { preparation.release(); }
  expect(isTaskRuntimeBusyForDestructiveEdit(id)).toBe(false);
});
function seedLoop(status: string) {
  const file = join(root, "data", "goals-loop", "test-session.json");
  const loop = { id: "test-loop", sessionId: "test-session", cwd: root, status, goal: "fix", acceptance: [],
    maxTurns: 2, cooldownSeconds: 0, nextTurnAt: null, forceFullRun: false, turnCount: 0, turnKind: "goal",
    pauseReason: "user", error: "", progress: [], summary: "", evidence: "", blockedReason: "", rejectedClaims: 0, unreadableStreak: 0 };
  mkdirSync(join(root, "data", "goals-loop"), { recursive: true });
  writeFileSync(file, JSON.stringify(loop));
  return { file, loop };
}
it.each(["paused", "blocked"])("the main stop terminates a live session's %s Goal Loop", async (status) => {
  const { file, loop } = seedLoop(status);
  session.extensionRunner.getCommand.mockReturnValue({ handler: () => writeFileSync(file, JSON.stringify({ ...loop, status: "stopped" })) });
  await abortTask(id);
  expect(session.extensionRunner.getCommand).toHaveBeenCalledWith("goal-stop");
  expect(JSON.parse(readFileSync(file, "utf8")).status).toBe("stopped");
});
it("a Goal command that failed to persist is not acknowledged as a successful stop", async () => {
  seedLoop("queued");
  session.extensionRunner.getCommand.mockReturnValue({ handler: () => {} });
  await expect(goalLoopCommand(id, { action: "stop" })).rejects.toMatchObject({ status: 409 });
  await expect(abortTask(id)).rejects.toMatchObject({ status: 409 });
  expect(session.abort).toHaveBeenCalledOnce();
});
it("cancelling a queued resend preserves undo until a turn actually starts", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  runtime.promptChain = gate;
  runtime.revertLeafId = "tip"; patchTask(id, { revertLeafId: "tip" });
  try {
    await promptTask(id, "resend");
    await abortTask(id);
    expect(getTask(id)?.revertLeafId).toBe("tip");
  } finally { release(); await runtime.promptChain; }
  expect(session.prompt).not.toHaveBeenCalled();
});
it("rewinding stops an owned Goal Loop between turns then navigates", async () => {
  const { file, loop } = seedLoop("queued");
  session.extensionRunner.getCommand.mockReturnValue({
    handler: () => writeFileSync(file, JSON.stringify({ ...loop, status: "stopped" })),
  });
  await revertTask(id, "late");
  expect(session.extensionRunner.getCommand).toHaveBeenCalledWith("goal-stop");
  expect(JSON.parse(readFileSync(file, "utf8")).status).toBe("stopped");
  expect(getTask(id)?.revertLeafId).toBe("tip");
  expect(leaf).toBe("early");
});
it("an SDK-aborted navigation does not report success or set a restore marker", async () => {
  session.navigateTree.mockImplementation(async () => ({ cancelled: false, aborted: true, editorText: "" }));
  await expect(revertTask(id, "late")).rejects.toMatchObject({ status: 400 });
  expect(leaf).toBe("tip"); expect(getTask(id)?.revertLeafId).toBeFalsy();
});
it("multiple rewinds preserve the original full transcript for undo", async () => {
  await revertTask(id, "late");
  await revertTask(id, "early");
  expect(getTask(id)?.revertLeafId).toBe("tip");
  await unrevertTask(id); expect(leaf).toBe("tip"); expect(getTask(id)?.revertLeafId).toBeNull();
});
it("concurrent rewinds cannot navigate one SDK session at the same time", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const navigate = session.navigateTree.getMockImplementation()!;
  session.navigateTree.mockImplementation(async (entryId) => { await gate; return navigate(entryId); });
  const first = revertTask(id, "late");
  await vi.waitFor(() => expect(session.navigateTree).toHaveBeenCalledOnce());
  const second = revertTask(id, "early").catch((error: Error & { status?: number }) => error);
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(session.navigateTree).toHaveBeenCalledOnce();
  } finally { release(); await Promise.allSettled([first, second]); }
  expect(await second).toMatchObject({ status: 409 });
});
it("route replacement, effort changes and compaction cannot overlap tree navigation", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const navigate = session.navigateTree.getMockImplementation()!;
  session.navigateTree.mockImplementation(async (entryId) => { await gate; return navigate(entryId); });
  const rewind = revertTask(id, "late");
  await vi.waitFor(() => expect(session.navigateTree).toHaveBeenCalledOnce());
  try {
    expect(isTaskRuntimeBusyForDestructiveEdit(id)).toBe(true);
    for (const mutate of [() => setTaskAgent(id, "reviewer"), () => setTaskModel(id, "invalid"), () => setTaskThinkingLevel(id, "high"), () => compactTask(id)]) {
      await expect(mutate()).rejects.toMatchObject({ status: 409 });
    }
    expect(session.compact).not.toHaveBeenCalled();
    expect(session.setThinkingLevel).not.toHaveBeenCalled();
  } finally { release(); await rewind; }
});
it("sending while tree navigation is pending is refused before changing the session", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const navigate = session.navigateTree.getMockImplementation()!;
  session.navigateTree.mockImplementation(async (entryId) => { await gate; return navigate(entryId); });
  const rewind = revertTask(id, "late");
  await vi.waitFor(() => expect(session.navigateTree).toHaveBeenCalledOnce());
  try { await expect(promptTask(id, "new turn")).rejects.toMatchObject({ status: 409 }); }
  finally { release(); await rewind; }
  expect(session.prompt).not.toHaveBeenCalled();
});
