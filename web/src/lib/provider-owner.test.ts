import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { writeProviderModelState, setProviderModelContextWindow } from "@/lib/provider-model-state";
import { writeProviderRouting } from "@/lib/provider-routing";
import { setProviderBaseUrl } from "@/lib/provider-endpoints";
const mocks = vi.hoisted(() => ({ listModelsForAccounts: vi.fn(), listProviderAuth: vi.fn(), listProviderModelsCatalog: vi.fn(), invalidateHealthCache: vi.fn(), saveProviderModelsOrder: vi.fn() }));
vi.mock("@/lib/pi/harness", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  mocks.saveProviderModelsOrder.mockImplementation(actual.saveProviderModelsOrder as (...args: unknown[]) => Promise<void>);
  return { ...actual, ...mocks };
});
vi.mock("@/lib/codexbar/cache", () => ({ getCachedUsage: vi.fn(() => null) }));
vi.mock("@/lib/model-throughput-stats", () => ({ modelThroughputKey: (p: string, m: string) => `${p}::${m}`, readModelThroughputAverages: vi.fn(async () => new Map([["fixture::model", 42]])) }));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-provider-owner-"));
  for (const [key, value] of Object.entries({ LEAFCODE_PI_DATA_DIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), LEAFCODE_PI_PROCESS_ROLE: "backend", LEAFCODE_PI_WEBUI_AUTH: "" })) vi.stubEnv(key, value);
  mocks.invalidateHealthCache.mockReset();
  mocks.listModelsForAccounts.mockReset().mockResolvedValue([{ value: "fixture/model", label: "Model", providerID: "fixture", modelID: "model", subscription: true, input: ["text"], reasoning: true, token: "PRIVATE" }]);
  mocks.listProviderAuth.mockReset().mockResolvedValue([{ id: "fixture", name: "Fixture", authenticated: true, methods: ["api_key"], authLabel: "Account", token: "PRIVATE" }]);
  mocks.listProviderModelsCatalog.mockReset().mockResolvedValue([{ id: "fixture", name: "Fixture", enabled: true, accountIds: ["a", "b"], models: [{ id: "model", name: "Model", enabled: true, contextWindow: 8192, token: "PRIVATE" }], token: "PRIVATE" }]);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function request(route: string, method: string, body?: unknown, operationId = randomUUID(), query = "") {
  const result = await dispatchJsonBusinessRequest({ route, method, operationId, url: `http://localhost/api/${route}${query}`, headers: { host: "localhost" }, authorized: true,
    ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }) });
  return publicJsonBusinessResult(route, result)!;
}
describe("Backend provider/model owner", () => {
  it("returns account-aware catalog/auth/options and throughput without SDK credentials", async () => {
    for (const route of ["models", "provider-models", "providers"]) {
      const result = await request(route, "GET", undefined, undefined, "?accountId=fixture-account");
      expect(result.status).toBe(200); expect(JSON.stringify(result)).not.toContain("PRIVATE");
      if (route === "models") expect(result.body).toMatchObject({ models: [{ avgTokensPerSecond: 42, reasoning: true, subscription: true }] });
      if (route === "provider-models") expect(result.body).toMatchObject({ providers: [{ accountIds: ["a", "b"], models: [{ contextWindow: 8192 }] }] });
    }
    expect(mocks.listProviderAuth).toHaveBeenCalledWith("fixture-account");
  });
  it("owns model flags, hints, clearing and ordering with a durable revision", async () => {
    const route = "provider-models/fixture%3A%3Amodel";
    for (const body of [{ enabled: false }, { contextWindow: 16384 }, { defaultThinkingLevel: "high" }, { defaultThinkingLevel: null }]) {
      const result = await request(route, "PATCH", body);
      expect(result.status).toBe(200); expect(result.body).toMatchObject({ mutation: { saved: true, apply: "not-required", saveStatus: "complete" } });
    }
    const order = await request("provider-models/order", "PATCH", { providerOrder: ["fixture"], modelOrder: { fixture: ["model"] } });
    expect(order.body).toMatchObject({ mutation: { saved: true } });
    const state = JSON.parse(readFileSync(join(root, "provider-model-state.json"), "utf8"));
    expect(state).toMatchObject({ disabled: { "fixture::model": true }, contextWindow: { "fixture::model": 16384 }, defaultThinkingLevel: {}, providerOrder: ["fixture"], modelOrder: { fixture: ["model"] } });
  });
  it("does not double-decode an opaque provider/model identifier", async () => {
    const result = await request("provider-models/fixture%3A%3Amodel%252Fname", "PATCH", { contextWindow: 8192 });
    expect(result.status).toBe(200);
    expect(JSON.parse(readFileSync(join(root, "provider-model-state.json"), "utf8")).contextWindow["fixture::model%2Fname"]).toBe(8192);
  });
  it("stores an endpoint but accurately defers native runtime application, and refuses replay", async () => {
    const id = randomUUID(), route = "providers/leafcodecloud/base-url";
    const saved = await request(route, "PUT", { baseUrl: "https://fixture.test/v1/" }, id);
    expect(saved.body).toMatchObject({ baseUrl: "https://fixture.test/v1", mutation: { saved: true, apply: "deferred" } });
    expect((await request(route, "GET")).body).toEqual({ baseUrl: "https://fixture.test/v1" });
    expect((await request(route, "PUT", { baseUrl: "https://other.test" }, id)).status).toBe(409);
    expect(JSON.parse(readFileSync(join(root, "provider-endpoints.json"), "utf8")).leafcodecloud).toBe("https://fixture.test/v1");
  });
  it("preserves routing validation, URI/body constraints and truthful non-saves", async () => {
    const saved = await request("providers/openai", "PATCH", { accountRoutingMode: "separate" }); expect(saved.body).toMatchObject({ mutation: { saved: true } });
    expect(JSON.parse(readFileSync(join(root, "provider-routing.json"), "utf8")).modes.openai).toBe("separate");
    for (const [route, method, body] of [
      ["providers/openai", "PATCH", { accountRoutingMode: "integrated" }],
      ["providers/leafcodecloud/base-url", "PUT", { baseUrl: "https://user:secret@fixture.test" }],
      ["provider-models/fixture%3A%3Amodel", "PATCH", { contextWindow: 4095 }],
      ["provider-models/order", "PATCH", { providerOrder: [42] }],
    ] as const) {
      const refused = await request(route, method, body); expect(refused.status).toBe(400); expect(refused.body).toMatchObject({ mutation: { saved: false, saveStatus: "none" } });
    }
  });
  it("reports a partial save on a later domain failure without leaking its exception", async () => {
    mocks.saveProviderModelsOrder.mockImplementationOnce(async () => {
      writeProviderModelState({ disabled: {}, providerOrder: ["fixture"], modelOrder: {} });
      throw new Error("PRIVATE FAILURE");
    });
    const partial = await request("provider-models/order", "PATCH", { providerOrder: ["fixture"] });
    expect(partial.status).toBe(500); expect(partial.body).toMatchObject({ mutation: { saved: true, saveStatus: "partial", apply: "failed" } });
    expect(JSON.stringify(partial)).not.toContain("PRIVATE");
  });
  it("masks native catalog errors and disallows Next common writers without side effects", async () => {
    mocks.listProviderAuth.mockRejectedValueOnce(Object.assign(new Error("PRIVATE token"), { status: 401 }));
    const error = await request("providers", "GET"); expect(error.status).toBe(401); expect(JSON.stringify(error)).not.toContain("PRIVATE");
    vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next");
    expect(() => writeProviderModelState({ disabled: {}, providerOrder: [], modelOrder: {} })).toThrow("owned by Backend");
    await expect(setProviderModelContextWindow("fixture", "model", 8192)).rejects.toThrow("owned by Backend");
    expect(() => writeProviderRouting({ version: 1, modes: {} })).toThrow("owned by Backend");
    expect(() => setProviderBaseUrl("leafcodecloud", "https://fixture.test")).toThrow("owned by Backend");
    expect(readdirSync(root)).toEqual([]);
  });
});
