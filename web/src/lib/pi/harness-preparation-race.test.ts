import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ model: vi.fn(), prompt: vi.fn(), start: vi.fn(), setModel: vi.fn() }));
vi.mock("@/lib/pi/harness", async (original) => {
  const actual = await original<typeof import("@/lib/pi/harness")>();
  return { ...actual, resolveAutoModel: mocks.model, promptTask: mocks.prompt,
    goalLoopCommand: mocks.start, setTaskModel: mocks.setModel,
    setTaskThinkingLevel: vi.fn(), setTaskAgent: vi.fn() };
});
import { abortTask, abortTaskIncludingColdGoalLoop } from "./harness";
import { handleTaskPrompt } from "./task-prompt";
import { startGoalLoopWithSelection } from "./goal-loop-start";
import { insertTask } from "@/lib/store";
let root: string;
let previousHarness: unknown;
const globals = globalThis as Record<string, unknown>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-preparation-race-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
  previousHarness = globals.__leafcodePiHarness;
  globals.__leafcodePiHarness = { live: new Map() };
  vi.clearAllMocks(); mocks.prompt.mockResolvedValue({ id: "accepted" });
  mocks.start.mockResolvedValue({ status: "queued" });
});
afterEach(() => {
  if (previousHarness === undefined) delete globals.__leafcodePiHarness;
  else globals.__leafcodePiHarness = previousHarness;
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
it.each(["chat", "goal", "chat-cold", "goal-cold"])("a stop during %s Auto selection must cancel the unsent request", async (kind) => {
  const task = insertTask({ project: null, title: "pending Auto" });
  let release!: (value: unknown) => void;
  mocks.model.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const pending = kind.startsWith("chat")
    ? handleTaskPrompt(task.id, { prompt: "fix", auto: true })
    : startGoalLoopWithSelection(task.id, { goal: "fix", auto: true }).catch((error: Error & { status: number }) => ({ status: error.status }));
  await vi.waitFor(() => expect(mocks.model).toHaveBeenCalledOnce());
  // Cover both the raw abort and the actual Backend HTTP callback's idle/cold shortcut.
  if (kind.endsWith("-cold")) await abortTaskIncludingColdGoalLoop(task.id);
  else await abortTask(task.id);
  release({ providerID: "test", modelID: "selected", variant: "high", mode: "balanced", tier: "heavy", reason: "test" });
  const result = await pending;
  expect(result).toMatchObject({ status: 409 });
  expect(mocks.prompt).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.setModel).not.toHaveBeenCalled();
});
