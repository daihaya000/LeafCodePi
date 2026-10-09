import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("@/lib/http-compression-fix", () => ({ installContentTypeStringHeader: state.install }));
import { register } from "./instrumentation";
import { assertLocalRuntimeAllowed, isBackendRuntimeHost, localRuntimeBlocked, webOwnsRuntime } from "./lib/pi/runtime-ownership";

beforeEach(() => { state.install.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Next transport startup", () => {
  for (const mode of ["development", "production", "test"]) {
    it(`starts only HTTP transport and refuses runtime ownership in ${mode}`, async () => {
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend");
      vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "attach");
      await register();
      expect(process.env.LEAFCODE_PI_PROCESS_ROLE).toBe("next");
      expect(state.install).toHaveBeenCalledOnce();
      expect(webOwnsRuntime()).toBe(false);
      expect(isBackendRuntimeHost()).toBe(false);
      expect(localRuntimeBlocked()).toBe(true);
      expect(() => assertLocalRuntimeAllowed()).toThrow(/Backend/);
    });
  }

  it("repeated registrations install only the idempotent transport patch", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    await register();
    await register();
    expect(state.install).toHaveBeenCalledTimes(3);
    expect(process.env.LEAFCODE_PI_PROCESS_ROLE).toBe("next");
  });

  it("keeps runtime refusal when the optional HTTP patch fails", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("LEAFCODE_PI_BACKEND_RUNTIME", "1");
    state.install.mockImplementation(() => { throw new Error("patch unavailable"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await register();
    expect(localRuntimeBlocked()).toBe(true);
    expect(warning).toHaveBeenCalledWith("[http] content-type header fix unavailable", expect.any(Error));
  });

  it("does not install Node services in Edge", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(state.install).not.toHaveBeenCalled();
  });
});
