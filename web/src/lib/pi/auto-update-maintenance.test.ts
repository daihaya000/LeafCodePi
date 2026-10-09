import { afterEach, expect, it, vi } from "vitest";
import { autoUpdateMaintenanceActive, assertAutoUpdateAvailable, setAutoUpdateMaintenance } from "./auto-update-maintenance";
import { beginTaskPreparation, hasActiveTaskOperations, withTaskTreeEdit } from "./task-operation-guard";
import { assertLocalRuntimeAllowed } from "./runtime-ownership";
afterEach(() => { setAutoUpdateMaintenance(false); vi.useRealTimers(); });
it("blocks new preparations, tree edits and runtime starts until released", async () => {
  setAutoUpdateMaintenance(true);
  expect(autoUpdateMaintenanceActive()).toBe(true);
  expect(() => beginTaskPreparation("new")).toThrow(/自動更新/);
  expect(() => assertLocalRuntimeAllowed({ LEAFCODE_PI_BACKEND_RUNTIME: "1" })).toThrow(/自動更新/);
  await expect(withTaskTreeEdit("new", async () => {})).rejects.toThrow(/自動更新/);
  setAutoUpdateMaintenance(false);
  const preparation = beginTaskPreparation("new");
  expect(hasActiveTaskOperations()).toBe(true);
  preparation.release();
  expect(hasActiveTaskOperations()).toBe(false);
});
it("expires if the Host dies instead of stranding the runtime", () => {
  vi.useFakeTimers(); setAutoUpdateMaintenance(true);
  vi.advanceTimersByTime(5 * 60_000);
  expect(assertAutoUpdateAvailable).not.toThrow();
});
