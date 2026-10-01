import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskLeaseService } from "@backend-core/task-runtime-lease.mjs";

vi.mock("@/lib/paths", () => ({ dataDir: vi.fn(() => { throw new Error("client must not access leases"); }) }));
vi.mock("@/lib/store", () => ({ listTasks: vi.fn(() => []), patchTask: vi.fn() }));
import { reconcileOrphanedWorkingTasks } from "./task-runtime-lease";

beforeEach(() => {
  vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("orphan reconciliation belongs to the runtime owner", () => {
  it("production client reads cannot consume orphan notifications or rewrite tasks", () => {
    vi.stubEnv("NODE_ENV", "production");
    const reconcile = vi.spyOn(TaskLeaseService.prototype, "reconcileOrphanedWorkingTasks");
    expect(reconcileOrphanedWorkingTasks()).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it("the production Backend still reconciles and can register restart resume", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "attach");
    const reconcile = vi.spyOn(TaskLeaseService.prototype, "reconcileOrphanedWorkingTasks").mockReturnValue(["orphan"]);
    expect(reconcileOrphanedWorkingTasks()).toEqual(["orphan"]);
    expect(reconcile).toHaveBeenCalledOnce();
  });
  it("standalone development keeps its owning-mode recovery", () => {
    vi.stubEnv("NODE_ENV", "development");
    const reconcile = vi.spyOn(TaskLeaseService.prototype, "reconcileOrphanedWorkingTasks").mockReturnValue(["dev-orphan"]);
    expect(reconcileOrphanedWorkingTasks()).toEqual(["dev-orphan"]);
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
