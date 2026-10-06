import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sessionResumeExtension, { RESUME_CANCEL_COMMAND, RESUME_ENTRY_TYPE, type ResumeReservation } from "./index";

type Entry = { type: "custom"; customType: string; data: unknown };
const shutdowns: Array<() => unknown> = [];
function harness(sessionId = randomUUID(), branch: Entry[] = []) {
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown>();
  let tool: ToolDefinition;
  let cancelCommand: { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
  let idle = true;
  let queued = false;
  let allowed = true;
  const ctx = {
    cwd: "/workspace",
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    isIdle: () => idle,
    hasPendingMessages: () => queued,
    ui: { setStatus: vi.fn() },
  } as unknown as ExtensionContext;
  const appendEntry = vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data: structuredClone(data) }));
  const sendMessage = vi.fn();
  const api = {
    on: (name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    registerCommand: (_name: string, command: typeof cancelCommand) => { cancelCommand = command; },
    appendEntry, sendMessage,
    getActiveTools: () => allowed ? ["session_resume"] : [],
  } as unknown as ExtensionAPI;
  sessionResumeExtension(api);
  const emit = (type: string, event: Record<string, unknown> = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  const result = {
    branch, appendEntry, sendMessage, ctx,
    start: () => emit("session_start"),
    emit,
    shutdown: () => emit("session_shutdown"),
    call: (args: Record<string, unknown>, signal = new AbortController().signal) => tool.execute("call", args as never, signal, undefined, ctx as never),
    cancelCommand: () => cancelCommand.handler("", ctx),
    idle: (value: boolean) => { idle = value; },
    queued: (value: boolean) => { queued = value; },
    allowed: (value: boolean) => { allowed = value; },
  };
  shutdowns.push(result.shutdown);
  result.start();
  return result;
}
const schedule = (h: ReturnType<typeof harness>, afterSeconds = 1, message = "処理結果を確認する") => h.call({ action: "schedule", afterSeconds, message });
const state = async (h: ReturnType<typeof harness>) => (await h.call({ action: "status" })).details as { reservation: ResumeReservation | null };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T09:00:00Z"));
});
afterEach(() => {
  shutdowns.splice(0).forEach((shutdown) => shutdown());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("session_resume", () => {
  it("returns immediately and fires once with the saved instruction", async () => {
    const h = harness();
    const result = await schedule(h);
    expect(result.isError).toBeUndefined();
    expect((await state(h)).reservation?.status).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      customType: "leafcode-session-resume-trigger", display: true,
      content: expect.stringContaining("処理結果を確認する"),
    }), { triggerTurn: true, deliverAs: "followUp" });
    expect((await state(h)).reservation?.status).toBe("fired");
    h.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("replaces an older reservation without firing both", async () => {
    const h = harness();
    await schedule(h, 1, "old");
    await schedule(h, 2, "new");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0][0].content).toContain("new");
  });

  it.each(["busy", "queued", "disabled"])("defers a due reservation while %s", async (reason) => {
    const h = harness();
    await schedule(h);
    if (reason === "busy") h.idle(false);
    if (reason === "queued") h.queued(true);
    if (reason === "disabled") h.allowed(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.sendMessage).not.toHaveBeenCalled();
    h.idle(true); h.queued(false); h.allowed(true);
    h.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["tool", "command", "input", "abort"])("cancels through %s", async (method) => {
    const h = harness();
    await schedule(h);
    if (method === "tool") await h.call({ action: "cancel" });
    if (method === "command") await h.cancelCommand();
    if (method === "input") h.emit("input", { source: "rpc" });
    if (method === "abort") h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect((await state(h)).reservation?.status).toBe("cancelled");
  });

  it("keeps reservations through steering and extension input", async () => {
    const h = harness();
    await schedule(h);
    h.emit("input", { source: "rpc", streamingBehavior: "steer" });
    h.emit("input", { source: "rpc", streamingBehavior: "followUp" });
    h.emit("input", { source: "extension" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("restores an overdue reservation only for its owning session", async () => {
    const id = randomUUID();
    const first = harness(id);
    await schedule(first);
    first.shutdown();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.sendMessage).not.toHaveBeenCalled();
    const fork = harness(randomUUID(), first.branch);
    await vi.advanceTimersByTimeAsync(0);
    expect(fork.sendMessage).not.toHaveBeenCalled();
    const restored = harness(id, first.branch);
    await vi.advanceTimersByTimeAsync(0);
    expect(restored.sendMessage).toHaveBeenCalledTimes(1);
    restored.shutdown();
    const consumed = harness(id, first.branch);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(consumed.sendMessage).not.toHaveBeenCalled();
  });

  it("retires an old runtime and ignores its late shutdown", async () => {
    const id = randomUUID();
    const old = harness(id);
    await schedule(old);
    const next = harness(id, old.branch);
    old.shutdown();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(old.sendMessage).not.toHaveBeenCalled();
    expect(next.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a reservation when navigating to a branch without it", async () => {
    const h = harness();
    await schedule(h);
    h.branch.length = 0;
    h.emit("session_tree");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect((await state(h)).reservation).toBeNull();
  });

  it("fails closed on a malformed latest persisted record", async () => {
    const h = harness();
    await schedule(h);
    h.branch.push({ type: "custom", customType: RESUME_ENTRY_TYPE, data: { version: 1, at: "invalid" } });
    h.emit("session_tree");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("does not revive an abandoned branch changed without an event", async () => {
    const h = harness();
    await schedule(h);
    h.branch.length = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("accepts an absolute ISO timestamp with a timezone", async () => {
    const h = harness();
    expect((await h.call({ action: "schedule", at: "2026-10-06T18:00:02+09:00", message: "check" })).isError).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { afterSeconds: 0 }, { afterSeconds: 1.5 }, { afterSeconds: 86401 },
    { at: "2026-10-06T09:00:05" }, { at: "Tue, 06 Oct 2026 09:00:02Z" }, { at: "2026-10-06T08:00:00Z" },
    { at: "2026-10-08T09:00:00Z" }, { afterSeconds: 1, at: "2026-10-06T09:00:05Z" },
    { afterSeconds: 1, message: " " }, { afterSeconds: 1, message: "x".repeat(4001) },
  ])("rejects invalid schedules %j", async (extra) => {
    const h = harness();
    const result = await h.call({ action: "schedule", message: "check", ...extra });
    expect(result.isError).toBe(true);
    expect(h.appendEntry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the earlier reservation if replacing it cannot be persisted", async () => {
    const h = harness();
    await schedule(h);
    h.appendEntry.mockImplementationOnce(() => { throw new Error("disk full"); });
    expect((await schedule(h, 10)).isError).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("never sends if consumption cannot be persisted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    await schedule(h);
    h.appendEntry.mockImplementationOnce(() => { throw new Error("disk full"); });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect((await state(h)).reservation?.status).toBe("failed");
  });

  it("still clears the live timer when cancellation persistence fails", async () => {
    const h = harness();
    await schedule(h);
    h.appendEntry.mockImplementationOnce(() => { throw new Error("disk full"); });
    expect((await h.call({ action: "cancel" })).isError).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects calls after shutdown or with an aborted signal", async () => {
    const h = harness();
    const controller = new AbortController(); controller.abort();
    expect((await h.call({ action: "schedule", afterSeconds: 1, message: "check" }, controller.signal)).isError).toBe(true);
    h.shutdown();
    expect((await schedule(h)).isError).toBe(true);
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it("exposes a model-free cancel command", () => {
    expect(RESUME_CANCEL_COMMAND).toBe("session-resume-cancel");
  });
});
