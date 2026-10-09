import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeNotOwnedError,
  assertLocalRuntimeAllowed,
  isBackendRuntimeHost,
  isRuntimeNotOwnedError,
  localRuntimeBlocked,
  setRuntimeOwnerUnavailable,
  webOwnsRuntime,
} from "./runtime-ownership";

describe("runtime ownership", () => {
  afterEach(() => setRuntimeOwnerUnavailable(false));
  it("is decided by the build: production is a client, development owns the runtime", () => {
    expect(webOwnsRuntime({})).toBe(true);
    expect(webOwnsRuntime({ NODE_ENV: "development" })).toBe(true);
    expect(webOwnsRuntime({ NODE_ENV: "test" })).toBe(true);
    expect(webOwnsRuntime({ NODE_ENV: "production" })).toBe(false);
    expect(webOwnsRuntime({ NODE_ENV: " PRODUCTION " })).toBe(false);
    // The ownership switch is gone: no environment value can turn a production WebUI into an owner.
    expect(webOwnsRuntime({ NODE_ENV: "production", LEAFCODE_PI_BACKEND_OWNS_RUNTIME: "0" })).toBe(false);
    expect(webOwnsRuntime({ NODE_ENV: "production", LEAFCODE_PI_BACKEND_OWNS_RUNTIME: "in-process" })).toBe(false);
  });

  it("refuses Next in all modes even with an inherited Backend marker", () => {
    for (const mode of [undefined, "development", "production", "test"]) {
      for (const marker of [undefined, "1", "attach"]) {
        const env = { NODE_ENV: mode, LEAFCODE_PI_PROCESS_ROLE: "next", LEAFCODE_PI_BACKEND_RUNTIME: marker };
        expect(webOwnsRuntime(env)).toBe(false);
        expect(isBackendRuntimeHost(env)).toBe(false);
        expect(localRuntimeBlocked(env)).toBe(true);
        expect(() => assertLocalRuntimeAllowed(env)).toThrow(RuntimeNotOwnedError);
      }
    }
    expect(localRuntimeBlocked({ NODE_ENV: "production", LEAFCODE_PI_PROCESS_ROLE: "backend", LEAFCODE_PI_BACKEND_RUNTIME: "1" })).toBe(false);
  });

  it("recognises the Backend runtime host", () => {
    expect(isBackendRuntimeHost({})).toBe(false);
    for (const value of ["1", "true", "yes", "on", "attach"]) {
      expect(isBackendRuntimeHost({ LEAFCODE_PI_BACKEND_RUNTIME: value })).toBe(true);
    }
  });

  it("blocks local sessions for the shipped WebUI, never for the Backend", () => {
    expect(localRuntimeBlocked({})).toBe(false);
    expect(localRuntimeBlocked({ NODE_ENV: "production" })).toBe(true);
    // The Backend process owns the runtime: the WebUI's rule must never block it.
    expect(localRuntimeBlocked({ NODE_ENV: "production", LEAFCODE_PI_BACKEND_RUNTIME: "attach" })).toBe(false);
    expect(localRuntimeBlocked({ LEAFCODE_PI_BACKEND_RUNTIME: "attach" })).toBe(false);
  });

  it("blocks a development owner after its shared runtime slot is unavailable", () => {
    setRuntimeOwnerUnavailable(true);
    expect(localRuntimeBlocked({ NODE_ENV: "development" })).toBe(true);
    expect(localRuntimeBlocked({ NODE_ENV: "development", LEAFCODE_PI_BACKEND_RUNTIME: "attach" })).toBe(false);
  });

  it("asserting raises a typed error that carries no internals", () => {
    expect(() => assertLocalRuntimeAllowed({})).not.toThrow();
    try {
      assertLocalRuntimeAllowed({ NODE_ENV: "production" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isRuntimeNotOwnedError(error)).toBe(true);
      expect((error as RuntimeNotOwnedError).code).toBe("RUNTIME_NOT_OWNED");
      expect((error as Error).name).toBe("RuntimeNotOwnedError");
    }
    expect(isRuntimeNotOwnedError(new Error("other"))).toBe(false);
  });
});
