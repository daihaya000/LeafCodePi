import { afterEach, describe, expect, it, vi } from "vitest";
import { completeProviderLoginCallback, queueLoginStart } from "./harness";

const globalState = globalThis as Record<string, unknown>;
const key = "__leafcodePiHarness";
afterEach(() => { delete globalState[key]; });

describe("completeProviderLoginCallback", () => {
  it("routes only to the matching provider session", async () => {
    const completeCallback = vi.fn().mockResolvedValue(undefined);
    globalState[key] = { loginSession: { id: "session-1", providerId: "radius", completeCallback } };
    await completeProviderLoginCallback("radius", "session-1", "test-input");
    expect(completeCallback).toHaveBeenCalledWith("test-input");
  });

  it.each([
    ["radius", "stale"],
    ["anthropic", "session-1"],
    ["radius", ""],
  ])("rejects mismatched provider/session %s %s", async (provider, session) => {
    const completeCallback = vi.fn();
    globalState[key] = { loginSession: { id: "session-1", providerId: "radius", completeCallback } };
    await expect(completeProviderLoginCallback(provider, session, "test-input")).rejects.toMatchObject({ status: 409 });
    expect(completeCallback).not.toHaveBeenCalled();
  });

  it("rejects requests without an active login", async () => {
    globalState[key] = { loginSession: null };
    await expect(completeProviderLoginCallback("radius", "session-1", "test-input")).rejects.toMatchObject({ status: 409 });
  });
});

describe("queueLoginStart", () => {
  it("runs only when the queued session is still the current one", async () => {
    const holder: { loginSession: unknown } = { loginSession: "session-1" };
    const run = vi.fn(async () => undefined);
    queueLoginStart(holder, "session-1", run);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
  });

  it("skips a session that a newer login replaced before the microtask ran", async () => {
    const holder: { loginSession: unknown } = { loginSession: "session-1" };
    const superseded = vi.fn(async () => undefined);
    const winner = vi.fn(async () => undefined);
    queueLoginStart(holder, "session-1", superseded);
    // A second login cancels the first before either microtask runs.
    holder.loginSession = "session-2";
    queueLoginStart(holder, "session-2", winner);
    await Promise.resolve();
    expect(superseded).not.toHaveBeenCalled();
    expect(winner).toHaveBeenCalledOnce();
  });

  it("skips a session cancelled before its microtask ran", async () => {
    const holder: { loginSession: unknown } = { loginSession: "session-1" };
    const run = vi.fn(async () => undefined);
    queueLoginStart(holder, "session-1", run);
    holder.loginSession = null;
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });
});
