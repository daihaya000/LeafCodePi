import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getTask, insertTask, upsertProject } from "@/lib/store";
import { abortTask } from "./harness";

const globals = globalThis as Record<string, unknown>;
let previous: unknown;
let root: string;
let taskId: string;
let session: ReturnType<typeof makeSession>;
function makeSession() {
  return {
    sessionId: "resume-host-test", isStreaming: false, isCompacting: false,
    messages: [], agent: { state: { messages: [] } },
    abort: vi.fn(async () => {}), clearQueue: vi.fn(),
    extensionRunner: { getCommand: vi.fn<(name: string) => { handler: () => Promise<void> } | undefined>(), createCommandContext: () => ({}) },
    sessionManager: { getCwd: () => root, getBranch: () => [], getEntries: () => [], getLeafId: () => null },
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-resume-host-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  previous = globals.__leafcodePiHarness;
  const project = upsertProject({ name: "resume host", rootPath: root });
  taskId = insertTask({ project, title: "resume stop" }).id;
  session = makeSession();
  const live = {
    taskId, session, accountId: null, agentName: null, promptEpoch: 0, promptChain: Promise.resolve(),
    accountByMessageId: new Map(), agentByMessageId: new Map(), throughputByStartedAt: new Map(),
    toolStartedAt: new Map(), toolEndedAt: new Map(), toolPartialOutputByCallId: new Map(),
  };
  globals.__leafcodePiHarness = { events: new EventEmitter(), live: new Map([[taskId, live]]) };
});
afterEach(() => {
  if (previous === undefined) delete globals.__leafcodePiHarness; else globals.__leafcodePiHarness = previous;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});
it("routes Stop to the model-free cancellation command even when the session is idle", async () => {
  const cancel = vi.fn(async () => {});
  session.extensionRunner.getCommand.mockImplementation((name) => name === "session-resume-cancel" ? { handler: cancel } : undefined);
  await abortTask(taskId);
  expect(cancel).toHaveBeenCalledOnce();
  expect(session.abort).toHaveBeenCalledOnce();
  expect(getTask(taskId)?.status).toBe("idle");
});
it("still aborts and publishes idle if reservation persistence fails", async () => {
  session.extensionRunner.getCommand.mockImplementation((name) => name === "session-resume-cancel"
    ? { handler: async () => { throw new Error("resume cancellation failed"); } } : undefined);
  await expect(abortTask(taskId)).rejects.toThrow("resume cancellation failed");
  expect(session.abort).toHaveBeenCalledOnce();
  expect(getTask(taskId)?.status).toBe("idle");
});
