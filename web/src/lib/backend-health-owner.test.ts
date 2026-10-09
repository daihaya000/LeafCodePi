import { afterEach, beforeEach, expect, it, vi } from "vitest";
const spies = vi.hoisted(() => ({ getHealth: vi.fn(), invalidateHealthCache: vi.fn() }));
vi.mock("@backend-runtime/lib/pi/harness", () => spies);
import { dispatchBackendInformationRequest } from "@backend-runtime/json-business/backend-information";
const health = { ok: true, engine: "pi", engineOk: true, version: "1.0.0", modelCount: 7, dataDir: "/PRIVATE", warnings: ["PRIVATE"], error: null };
beforeEach(() => { vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend"); vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); spies.getHealth.mockReset(); spies.getHealth.mockResolvedValue(health); spies.invalidateHealthCache.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });
const input = (route = "health", authorized = false) => ({ route, method: route === "health" ? "GET" : "POST", url: "http://localhost/api/" + route, headers: {}, authorized });
it("Backend owns SDK health/cache; anonymous callers get only public metadata and authorized callers get known private fields", async () => {
  const publicResult = await dispatchBackendInformationRequest(input(), new Request("http://localhost")); expect(publicResult.status).toBe(200); expect(publicResult.body).not.toHaveProperty("dataDir"); expect(JSON.stringify(publicResult)).not.toContain("PRIVATE");
  const privateResult = await dispatchBackendInformationRequest(input("health", true), new Request("http://localhost")); expect(privateResult.body).toMatchObject({ dataDir: "/PRIVATE" }); expect(spies.getHealth).toHaveBeenCalledTimes(2);
});
it("cache invalidation is private and anonymous access cannot mutate it", async () => {
  expect((await dispatchBackendInformationRequest(input("health/cache"), new Request("http://localhost"))).status).toBe(401); expect(spies.invalidateHealthCache).not.toHaveBeenCalled();
  expect((await dispatchBackendInformationRequest(input("health/cache", true), new Request("http://localhost"))).status).toBe(200); expect(spies.invalidateHealthCache).toHaveBeenCalledTimes(1);
});
it("explicit Next role is refused before SDK health or cache effects; owner errors do not expose internals", async () => {
  spies.getHealth.mockRejectedValueOnce(new Error("PRIVATE")); const failed = await dispatchBackendInformationRequest(input(), new Request("http://localhost")); expect(failed.status).toBe(503); expect(JSON.stringify(failed)).not.toContain("PRIVATE");
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next"); await expect(dispatchBackendInformationRequest(input(), new Request("http://localhost"))).rejects.toThrow(/owned by Backend/); expect(spies.getHealth).toHaveBeenCalledTimes(1);
});
