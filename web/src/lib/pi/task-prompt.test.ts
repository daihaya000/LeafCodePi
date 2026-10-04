import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getTask: vi.fn(), prompt: vi.fn(), model: vi.fn(), agent: vi.fn(), validate: vi.fn() }));
vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/direct-session", () => ({ readSessionConversation: () => [] }));
vi.mock("@/lib/auto-agent", () => ({ autoAgentHasOwnModel: () => false, resolveAutoAgent: mocks.agent }));
vi.mock("@/lib/pi/harness", () => ({ promptTask: mocks.prompt, resolveAutoModel: mocks.model, validateTaskModelSelection: mocks.validate,
  isRecoverableResumeSelectionError: () => false, jsonError: (e: Error & { status?: number }) => ({ error: e.message, status: e.status ?? 500 }),
}));
import { handleTaskPrompt } from "./task-prompt";
import { AUTO_AGENT_VALUE } from "@/lib/default-agent";
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "attach");
  mocks.getTask.mockReturnValue({ id: "task", status: "idle" });
  mocks.prompt.mockResolvedValue({ id: "task" }); mocks.agent.mockResolvedValue("reviewer");
  mocks.model.mockResolvedValue({ providerID: "test", modelID: "selected", variant: "high", tier: "heavy", mode: "balanced", reason: "test" });
});
afterEach(() => vi.unstubAllEnvs());
it("the production Backend resolves Auto model/agent and returns the decision", async () => {
  const result = await handleTaskPrompt("task", { prompt: "fix", auto: true, agent: AUTO_AGENT_VALUE });
  expect(result.status).toBe(200); expect(result.body.autoDecision?.modelID).toBe("selected");
  expect(mocks.model).toHaveBeenCalledOnce(); expect(mocks.agent).toHaveBeenCalledOnce();
  expect(mocks.prompt).toHaveBeenCalledWith("task", "fix", undefined, expect.objectContaining({ model: "test::selected", thinkingLevel: "high", agent: "reviewer", accountIdExplicit: false }));
});
it("Auto retry preserves its explicit selected route without selecting again", async () => {
  await handleTaskPrompt("task", { prompt: "retry", auto: true, autoRetry: true, model: "test::retry" });
  expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.validate).toHaveBeenCalledWith("test::retry");
});
it("a working turn cannot change its model/agent through stale Auto metadata", async () => {
  mocks.getTask.mockReturnValue({ id: "task", status: "working", agent: "current" });
  await handleTaskPrompt("task", { prompt: "steer", auto: true, agent: AUTO_AGENT_VALUE });
  expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.agent).not.toHaveBeenCalled();
  expect(mocks.prompt).toHaveBeenCalledWith("task", "steer", undefined, expect.objectContaining({ model: undefined, agent: "current" }));
});
it("forwards impact-aware steering without changing the active route", async () => {
  mocks.getTask.mockReturnValue({ id: "task", status: "working", agent: "current" });
  const result = await handleTaskPrompt("task", { prompt: "new direction", auto: true, agent: AUTO_AGENT_VALUE,
    streamingBehavior: "steer", interruptIfSafe: true });
  expect(result.status).toBe(200);
  expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.agent).not.toHaveBeenCalled();
  expect(mocks.prompt).toHaveBeenCalledWith("task", "new direction", undefined,
    expect.objectContaining({ streamingBehavior: "steer", interruptIfSafe: true, agent: "current" }));
});
it.each([
  { interruptIfSafe: "true", streamingBehavior: "steer" },
  { interruptIfSafe: true },
  { interruptIfSafe: true, streamingBehavior: "followUp" },
])("rejects invalid immediate interruption options: %j", async (options) => {
  expect((await handleTaskPrompt("task", { prompt: "fix", ...options } as never)).status).toBe(400);
  expect(mocks.prompt).not.toHaveBeenCalled();
});
it("a client cannot execute the owning ladder", async () => {
  vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "");
  const result = await handleTaskPrompt("task", { prompt: "fix", auto: true });
  expect(result.status).not.toBe(200); expect(mocks.getTask).not.toHaveBeenCalled(); expect(mocks.prompt).not.toHaveBeenCalled();
});
it("owner failures retain their HTTP contract", async () => {
  mocks.prompt.mockRejectedValue(Object.assign(new Error("busy"), { status: 409 }));
  expect(await handleTaskPrompt("task", { prompt: "fix" })).toEqual({ status: 409, body: { error: "busy" } });
});
