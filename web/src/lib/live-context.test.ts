import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reloadLiveSessionsContext: vi.fn(),
  refreshLiveSessionsForAgentDefinition: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
  forwardLiveSessionsReload: vi.fn(),
}));
vi.mock("@/lib/pi/harness", () => ({
  reloadLiveSessionsContext: mocks.reloadLiveSessionsContext,
  refreshLiveSessionsForAgentDefinition: mocks.refreshLiveSessionsForAgentDefinition,
}));
vi.mock("@/lib/pi/runtime-ownership", () => ({ localRuntimeBlocked: mocks.localRuntimeBlocked }));
vi.mock("@/lib/backend-forward", () => ({ forwardLiveSessionsReload: mocks.forwardLiveSessionsReload }));

import { refreshLiveSessionsForAgentDefinition, reloadLiveSessionsContext } from "./live-context";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.localRuntimeBlocked.mockReturnValue(false);
});

describe("live session reload", () => {
  it("reloads this process's sessions while it owns the runtime", async () => {
    mocks.reloadLiveSessionsContext.mockResolvedValue({ reloaded: 1, deferred: 0, failed: 0, errors: [] });
    mocks.refreshLiveSessionsForAgentDefinition.mockReturnValue({ refreshed: 1, deferred: 0 });

    await expect(reloadLiveSessionsContext()).resolves.toEqual({ reloaded: 1, deferred: 0, failed: 0, errors: [] });
    await expect(refreshLiveSessionsForAgentDefinition("reviewer")).resolves.toEqual({ refreshed: 1, deferred: 0 });
    expect(mocks.forwardLiveSessionsReload).not.toHaveBeenCalled();
  });

  it("asks the owning Backend instead of reloading an empty local session table", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardLiveSessionsReload
      .mockResolvedValueOnce({ ok: true, result: { reloaded: 4, deferred: 1, failed: 0, errors: [] } })
      .mockResolvedValueOnce({ ok: true, result: { refreshed: 2, deferred: 0 } });

    await expect(reloadLiveSessionsContext()).resolves.toEqual({ reloaded: 4, deferred: 1, failed: 0, errors: [] });
    expect(mocks.forwardLiveSessionsReload).toHaveBeenLastCalledWith({ action: "reload" });
    await expect(refreshLiveSessionsForAgentDefinition("reviewer")).resolves.toEqual({ refreshed: 2, deferred: 0 });
    expect(mocks.forwardLiveSessionsReload).toHaveBeenLastCalledWith({ action: "refresh-agent", agentName: "reviewer" });
    expect(mocks.reloadLiveSessionsContext).not.toHaveBeenCalled();
    expect(mocks.refreshLiveSessionsForAgentDefinition).not.toHaveBeenCalled();
  });

  it("fails loudly when the Backend cannot answer, with no local fallback", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardLiveSessionsReload.mockResolvedValue({ ok: false, reason: "unreachable" });

    await expect(reloadLiveSessionsContext()).rejects.toThrow(/unreachable/);
    await expect(refreshLiveSessionsForAgentDefinition("reviewer")).rejects.toThrow(/unreachable/);
    expect(mocks.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
});
