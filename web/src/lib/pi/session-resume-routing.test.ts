import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, expect, it, vi } from "vitest";
import { registerSessionResumeTurnRouting } from "@backend-runtime/lib/pi/session-resume-routing";
import { RESUME_HOST_ROUTING_CHANNEL, RESUME_HOST_ROUTING_READY_CHANNEL, type ResumeHostRouting } from "@shared/session-resume";

const mocks = vi.hoisted(() => ({
  task: { status: "idle" },
  getTask: vi.fn(), setTaskStatus: vi.fn(),
  acquire: vi.fn(), owns: vi.fn(), release: vi.fn(),
  arm: vi.fn(), disarm: vi.fn(),
}));
vi.mock("@/lib/store", () => ({ getTask: mocks.getTask, setTaskStatus: mocks.setTaskStatus }));
vi.mock("@/lib/task-runtime-lease", () => ({ acquireTaskLease: mocks.acquire, ownsTaskLease: mocks.owns, releaseTaskLease: mocks.release }));
vi.mock("@/lib/pi/hang-watchdog", () => ({ armTaskHangWatch: mocks.arm, disarmTaskHangWatch: mocks.disarm }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.task.status = "idle";
  mocks.getTask.mockReturnValue(mocks.task);
  mocks.setTaskStatus.mockImplementation((_id, status) => { mocks.task.status = status; });
  mocks.acquire.mockReturnValue(true); mocks.owns.mockReturnValue(true);
});
function harness() {
  const manager = {};
  const live = { sessionManager: manager, busy: false, promptActive: false, leaseLost: false };
  const getLive = vi.fn(() => live);
  const notify = vi.fn();
  let start: (_event: unknown, ctx: ExtensionContext) => unknown;
  let routing: ResumeHostRouting;
  const emit = vi.fn((name, packet) => { if (name === RESUME_HOST_ROUTING_READY_CHANNEL) routing = packet; });
  registerSessionResumeTurnRouting("task", getLive, notify)({
    events: { emit },
    on: (_name: string, handler: typeof start) => { start = handler; },
  } as unknown as ExtensionAPI);
  const restore = () => start({}, { sessionManager: manager } as ExtensionContext);
  restore();
  return { live, getLive, notify, emit, restore, routing: () => routing };
}

it("announces host routing and commits a lease before working state", () => {
  const h = harness();
  expect(h.emit).toHaveBeenCalledWith(RESUME_HOST_ROUTING_CHANNEL, { taskId: "task" });
  expect(h.routing().prepare("check results")).toBe(true);
  expect(mocks.acquire).toHaveBeenCalledWith("task");
  expect(mocks.acquire.mock.invocationCallOrder[0]).toBeLessThan(mocks.setTaskStatus.mock.invocationCallOrder[0]);
  expect(mocks.task.status).toBe("working");
  expect(mocks.arm).toHaveBeenCalledWith({ taskId: "task", prompt: "check results", skipResume: true });
  expect(h.notify).toHaveBeenCalledWith("session_resume_prepared");
});

it.each(["busy", "leaseLost", "archived", "missing", "replaced", "foreign-lease"])("does not consume ownership while %s", (reason) => {
  const h = harness();
  if (reason === "busy") h.live.busy = true;
  if (reason === "leaseLost") h.live.leaseLost = true;
  if (reason === "archived") mocks.task.status = "archived";
  if (reason === "missing") mocks.getTask.mockReturnValue(undefined);
  if (reason === "replaced") h.live.sessionManager = {};
  if (reason === "foreign-lease") mocks.acquire.mockReturnValue(false);
  expect(h.routing().prepare("check")).toBe(false);
  expect(mocks.setTaskStatus).not.toHaveBeenCalled();
  expect(mocks.arm).not.toHaveBeenCalled();
  expect(mocks.release).not.toHaveBeenCalled();
});

it("returns working state and the lease when a prepared send fails", () => {
  const h = harness();
  h.routing().prepare("check");
  h.routing().release(); h.routing().release();
  expect(mocks.task.status).toBe("idle");
  expect(mocks.disarm).toHaveBeenCalledOnce();
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith("task");
});

it("leaves an accepted SDK turn's lifecycle to settlement", () => {
  const h = harness();
  h.routing().prepare("check"); h.live.promptActive = true;
  h.routing().release();
  expect(mocks.task.status).toBe("working");
  expect(mocks.release).not.toHaveBeenCalled();
});

it("retires stale routing on reload without releasing the successor's lease", () => {
  const h = harness();
  const old = h.routing(); old.prepare("old"); h.restore();
  expect(old.prepare("stale")).toBe(false);
  expect(h.routing().prepare("new")).toBe(true);
  old.release();
  expect(mocks.release).not.toHaveBeenCalled();
});
