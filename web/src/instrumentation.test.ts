import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ relay: vi.fn(), scheduler: vi.fn() }));
vi.mock("@/lib/pi/harness", () => ({ startBotCodeRelay: state.relay }));
vi.mock("@/lib/routines", () => ({ ensureRoutineScheduler: state.scheduler }));

import { register } from "./instrumentation";

describe("runtime startup", () => {
  beforeEach(() => {
    state.relay.mockReset();
    state.scheduler.mockReset();
  });

  it("starts the Bot relay and routine scheduler in Node.js", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    await register();

    expect(state.relay).toHaveBeenCalledOnce();
    expect(state.scheduler).toHaveBeenCalledOnce();
  });

  it("does not start server services in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    await register();

    expect(state.relay).not.toHaveBeenCalled();
    expect(state.scheduler).not.toHaveBeenCalled();
  });
});
