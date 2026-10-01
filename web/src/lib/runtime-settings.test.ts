import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ remote: vi.fn(), local: vi.fn() }));
vi.mock("@/lib/backend-client", () => ({ controlBackendRuntime: mocks.remote }));
vi.mock("@/lib/pi/harness", () => ({
  getCompactionSettings: mocks.local, setCompactionEnabled: mocks.local,
  getCacheWarmingMode: mocks.local, setCacheWarmingMode: mocks.local,
  refreshCompactionSuggestions: mocks.local, applyCodePermissionSettingsToLiveTasks: mocks.local, jsonError: mocks.local,
}));
import * as settings from "./runtime-settings";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", ""); mocks.remote.mockResolvedValue({ ok: true, body: { result: "saved" } }); });
afterEach(() => vi.unstubAllEnvs());
it("forwards all live settings and never traverses the client's empty session map", async () => {
  await settings.getCompactionSettings(); await settings.setCompactionEnabled(false);
  await settings.getCacheWarmingMode(); await settings.setCacheWarmingMode("off");
  await settings.refreshCompactionSuggestions(); await settings.applyCodePermissionSettingsToLiveTasks();
  expect(mocks.remote.mock.calls.map(([action]) => action)).toEqual(["read-compaction", "set-compaction", "read-cache-warming", "set-cache-warming", "refresh-compaction", "code-permissions"]);
  expect(mocks.remote).toHaveBeenCalledWith("set-compaction", false);
  expect(mocks.remote).toHaveBeenCalledWith("set-cache-warming", "off");
  expect(mocks.local).not.toHaveBeenCalled();
});
it("owner failure cannot be reported as success or fall back locally", async () => {
  mocks.remote.mockResolvedValue({ ok: false, reason: "unreachable" });
  await expect(settings.setCacheWarmingMode("off")).rejects.toMatchObject({ status: 503 });
  expect(mocks.local).not.toHaveBeenCalled();
});
it("development retains its local owner", async () => {
  vi.stubEnv("NODE_ENV", "development"); await settings.setCompactionEnabled(true);
  expect(mocks.local).toHaveBeenCalledWith(true); expect(mocks.remote).not.toHaveBeenCalled();
});
