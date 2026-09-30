import { describe, expect, it } from "vitest";
import {
  RuntimeNotOwnedError,
  assertLocalRuntimeAllowed,
  isBackendRuntimeHost,
  isRuntimeNotOwnedError,
  localRuntimeBlocked,
  webOwnsRuntime,
} from "./runtime-ownership";

describe("runtime ownership", () => {
  it("owns the runtime by default: the cutover is opt-in", () => {
    expect(webOwnsRuntime({})).toBe(true);
    expect(webOwnsRuntime({ LEAFCODE_PI_BACKEND_OWNS_RUNTIME: "" })).toBe(true);
    expect(webOwnsRuntime({ LEAFCODE_PI_BACKEND_OWNS_RUNTIME: "0" })).toBe(true);
    for (const value of ["1", "true", "yes", "on", " ON "]) {
      expect(webOwnsRuntime({ LEAFCODE_PI_BACKEND_OWNS_RUNTIME: value })).toBe(false);
    }
  });

  it("recognises the Backend runtime host", () => {
    expect(isBackendRuntimeHost({})).toBe(false);
    for (const value of ["1", "true", "yes", "on", "attach"]) {
      expect(isBackendRuntimeHost({ LEAFCODE_PI_BACKEND_RUNTIME: value })).toBe(true);
    }
  });

  it("blocks local sessions only for a WebUI that handed the runtime over", () => {
    expect(localRuntimeBlocked({})).toBe(false);
    expect(localRuntimeBlocked({ LEAFCODE_PI_BACKEND_OWNS_RUNTIME: "1" })).toBe(true);
    // The Backend process owns the runtime: the WebUI's switch must never block it.
    expect(localRuntimeBlocked({ LEAFCODE_PI_BACKEND_OWNS_RUNTIME: "1", LEAFCODE_PI_BACKEND_RUNTIME: "attach" })).toBe(false);
    expect(localRuntimeBlocked({ LEAFCODE_PI_BACKEND_RUNTIME: "attach" })).toBe(false);
  });

  it("asserting raises a typed error that carries no internals", () => {
    expect(() => assertLocalRuntimeAllowed({})).not.toThrow();
    try {
      assertLocalRuntimeAllowed({ LEAFCODE_PI_BACKEND_OWNS_RUNTIME: "1" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isRuntimeNotOwnedError(error)).toBe(true);
      expect((error as RuntimeNotOwnedError).code).toBe("RUNTIME_NOT_OWNED");
      expect((error as Error).name).toBe("RuntimeNotOwnedError");
    }
    expect(isRuntimeNotOwnedError(new Error("other"))).toBe(false);
  });
});
