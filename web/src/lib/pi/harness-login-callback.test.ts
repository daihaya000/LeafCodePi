import { afterEach, describe, expect, it, vi } from "vitest";
import { completeProviderLoginCallback } from "./harness";

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
