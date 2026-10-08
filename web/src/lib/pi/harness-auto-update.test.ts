import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { insertTask, patchTask, upsertProject } from "@/lib/store";
import { prepareAutoUpdate, readAutoUpdateState, releaseAutoUpdate } from "./harness";
import { beginTaskPreparation } from "./task-operation-guard";
import { goalLoopStateFile } from "./goal-loop-state";
import { registerBackgroundWorkProvider } from "@extensions/leafcode-subagents/src/api/background-work";
const globals = globalThis as Record<string, unknown>;
let previous: unknown;
let root: string;
let taskId: string;
let live: { taskId: string; promptActive: boolean; session: { isStreaming: boolean; isCompacting: boolean; sessionId: string; sessionManager: { getCwd: () => string } }; pendingTransportRecovery?: boolean };
let unregister: (() => void) | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lcp-idle-state-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  previous = globals.__leafcodePiHarness;
  const project = upsertProject({ name: "idle", rootPath: root });
  taskId = insertTask({ project, title: "idle task" }).id;
  patchTask(taskId, { status: "idle" });
  live = { taskId, promptActive: false, session: {
    isStreaming: false, isCompacting: false, sessionId: "idle-session", sessionManager: { getCwd: () => root },
  } };
  globals.__leafcodePiHarness = { events: new EventEmitter(), live: new Map([[taskId, live]]) };
});
afterEach(() => {
  releaseAutoUpdate(); unregister?.(); unregister = undefined;
  if (previous === undefined) delete globals.__leafcodePiHarness; else globals.__leafcodePiHarness = previous;
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
it("idle attached sessions allow a lease, while a new prompt is refused", () => {
  expect(readAutoUpdateState()).toEqual({ supported: true, busy: false });
  expect(prepareAutoUpdate()).toEqual({ prepared: true });
  expect(() => beginTaskPreparation(taskId)).toThrow(/自動更新/);
});
it.each(["prompt", "stream", "compact", "recovery", "stored", "preparation", "background"])("blocks %s work", (kind) => {
  let release: (() => void) | undefined;
  if (kind === "prompt") live.promptActive = true;
  if (kind === "stream") live.session.isStreaming = true;
  if (kind === "compact") live.session.isCompacting = true;
  if (kind === "recovery") live.pendingTransportRecovery = true;
  if (kind === "stored") patchTask(taskId, { status: "working" });
  if (kind === "preparation") release = beginTaskPreparation(taskId).release;
  if (kind === "background") unregister = registerBackgroundWorkProvider({
    name: "auto-update-test", listActiveWork: () => [{ id: "child", sessionId: "idle-session" }],
  });
  try {
    expect(readAutoUpdateState().busy).toBe(true);
    expect(prepareAutoUpdate()).toEqual({ prepared: false });
  } finally { release?.(); }
});
it.each(["queued", "running", "verifying_completed"])("blocks an idle-looking %s Goal Loop", (status) => {
  patchTask(taskId, { sessionId: "idle-session" });
  mkdirSync(join(root, "data", "goals-loop"), { recursive: true });
  writeFileSync(goalLoopStateFile(root, "idle-session"), JSON.stringify({ goal: "ship", status }));
  expect(readAutoUpdateState().busy).toBe(true);
  expect(prepareAutoUpdate()).toEqual({ prepared: false });
});
it("does not turn provider errors into an idle state", () => {
  unregister = registerBackgroundWorkProvider({ name: "auto-update-test", listActiveWork: () => { throw new Error("unavailable"); } });
  expect(readAutoUpdateState).toThrow("unavailable");
});
