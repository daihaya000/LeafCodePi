import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJevDiscoveryCache, discoverJevModels, registeredJevEndpoint } from "./jev-model-discovery";
import { resolveRegisteredJevConnection } from "./jev-model-connection";

type ClassifierConfig = Extract<NonNullable<Parameters<ModelRuntime["registerProvider"]>[1]["models"]>[number], { type: "classifier" }>;

const dirs: string[] = [];
beforeEach(clearJevDiscoveryCache);
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function runtime() {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-jev-sdk-"));
  dirs.push(dir);
  return ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false,
  });
}

function classifier(id = "judge-v1", baseUrl = "https://model.example/v1"): ClassifierConfig {
  return {
    id, name: "Decision model", type: "classifier", api: "typesafe-system-one", baseUrl,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000,
    headers: { "X-Model": "model-header" },
  };
}

const noNetwork = () => vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] })));

describe("Jev discovery against the installed SDK contract", () => {
  it("finds classifiers that the SDK deliberately excludes from getModels()", async () => {
    const rt = await runtime();
    rt.registerProvider("custom-systemone", {
      name: "Custom System One", baseUrl: "https://provider.example/v1", apiKey: "test-key",
      models: [classifier()],
    });
    expect(rt.getModels("custom-systemone")).toEqual([]);
    expect(rt.getAllModels("custom-systemone")).toHaveLength(1);
    const fetchImpl = noNetwork();
    const models = await discoverJevModels(rt, { providerIds: ["custom-systemone"] }, fetchImpl);
    expect(models).toMatchObject([{ providerId: "custom-systemone", modelId: "judge-v1", baseUrl: "https://model.example/v1" }]);
    expect(registeredJevEndpoint(rt, models[0])).toBe("https://model.example/v1");
    expect(await resolveRegisteredJevConnection(rt, models[0], fetchImpl)).toEqual({
      baseUrl: "https://model.example/v1", model: "judge-v1", apiKey: "test-key", headers: { "X-Model": "model-header" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps native model URL overrides instead of substituting a documented provider URL", async () => {
    const rt = await runtime();
    rt.registerProvider("typesafe", { apiKey: "test-key", models: [classifier("jev-private")] });
    const models = await discoverJevModels(rt, { providerIds: ["typesafe"] }, noNetwork());
    expect(models.find((model) => model.modelId === "jev-private")?.baseUrl).toBe("https://model.example/v1");
    expect(registeredJevEndpoint(rt, { providerId: "typesafe", modelId: "jev-private" })).toBe("https://model.example/v1");
  });

  it("resolves the classifier when chat and classifier models share an SDK id", async () => {
    const rt = await runtime();
    const decision = classifier("shared-id");
    rt.registerProvider("custom-systemone", { apiKey: "test-key", baseUrl: "https://provider.example/v1", models: [
      { ...decision, type: "chat", api: "openai-completions", baseUrl: "https://chat.example/v1", reasoning: false, maxTokens: 1024 },
      decision,
    ] });
    const fetchImpl = noNetwork();
    const models = await discoverJevModels(rt, { providerIds: ["custom-systemone"] }, fetchImpl);
    expect(models).toMatchObject([{ modelId: "shared-id", baseUrl: "https://model.example/v1" }]);
    expect(registeredJevEndpoint(rt, models[0])).toBe("https://model.example/v1");
    expect((await resolveRegisteredJevConnection(rt, models[0], fetchImpl)).headers).toEqual({ "X-Model": "model-header" });
  });

  it("honors auth-resolved URL and header overrides, rejecting unsafe URLs", async () => {
    const rt = await runtime();
    rt.registerProvider("custom-systemone", { apiKey: "test-key", models: [classifier()] });
    const ref = { providerId: "custom-systemone", modelId: "judge-v1" };
    const getAuth = vi.spyOn(rt, "getAuth").mockResolvedValue({ auth: {
      apiKey: "test-key", baseUrl: "https://auth.example/v1/", headers: { "X-Model": null, "X-Auth": "auth-header" },
    } });
    expect(await resolveRegisteredJevConnection(rt, ref, noNetwork())).toEqual({
      baseUrl: "https://auth.example/v1", model: "judge-v1", apiKey: "test-key", headers: { "X-Auth": "auth-header" },
    });
    expect(getAuth).toHaveBeenCalledWith(rt.getAllModels("custom-systemone")[0]);
    getAuth.mockResolvedValueOnce({ auth: { apiKey: "test-key", baseUrl: "https://user:password@example.com" } });
    await expect(resolveRegisteredJevConnection(rt, ref, noNetwork())).rejects.toThrow("接続URLが不正");
  });

  it("does not route incompatible classifier APIs or image models by a Jev-like name", async () => {
    const rt = await runtime();
    rt.registerProvider("typesafe", {
      apiKey: "test-key", models: [
        { ...classifier("jev-other"), api: "llama-cpp-classify" },
        { ...classifier("jev-image"), type: "image", api: "openrouter-images", output: ["image"] },
      ],
    });
    const fetchImpl = noNetwork();
    const models = await discoverJevModels(rt, { providerIds: ["typesafe"] }, fetchImpl);
    expect(models.map((model) => model.modelId)).toEqual(["jev-latest"]);
    await expect(resolveRegisteredJevConnection(rt, { providerId: "typesafe", modelId: "jev-other" }, fetchImpl)).rejects.toThrow("未検出");
    await expect(resolveRegisteredJevConnection(rt, { providerId: "typesafe", modelId: "jev-image" }, fetchImpl)).rejects.toThrow("未検出");
  });

  it("resolves remote decision models without Jev in their name and ignores their advertised URLs", async () => {
    const rt = await runtime();
    rt.registerProvider("openrouter", { apiKey: "test-key", models: [] });
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [
      { id: "vendor/decision-v1", architecture: { output_modalities: ["decisions"] }, baseUrl: "https://untrusted.example/v1" },
    ] })));
    const models = await discoverJevModels(rt, { providerIds: ["openrouter"] }, fetchImpl);
    expect(models).toMatchObject([{ modelId: "vendor/decision-v1", baseUrl: "https://openrouter.ai/api/v1" }]);
    expect(await resolveRegisteredJevConnection(rt, models[0], fetchImpl)).toEqual({
      baseUrl: "https://openrouter.ai/api/v1", model: "vendor/decision-v1", apiKey: "test-key", headers: {},
    });
    await expect(resolveRegisteredJevConnection(rt, { providerId: "openrouter", modelId: "typesafe/jev-invented" }, fetchImpl)).rejects.toThrow("未検出");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a native URL authoritative over a duplicate remote catalog entry", async () => {
    const rt = await runtime();
    rt.registerProvider("openrouter", { apiKey: "test-key", models: [classifier("typesafe/jev-private")] });
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [
      { id: "typesafe/jev-private", architecture: { output_modalities: ["decisions"] }, baseUrl: "https://untrusted.example/v1" },
    ] })));
    const models = await discoverJevModels(rt, { providerIds: ["openrouter"] }, fetchImpl);
    expect(models).toMatchObject([{ modelId: "typesafe/jev-private", baseUrl: "https://model.example/v1" }]);
    expect((await resolveRegisteredJevConnection(rt, models[0], fetchImpl)).baseUrl).toBe("https://model.example/v1");
  });

  it("rejects invalid native URLs rather than rerouting credentials to the provider default", async () => {
    const rt = await runtime();
    rt.registerProvider("typesafe", { apiKey: "test-key", models: [classifier("jev-latest", "https://user:password@example.com")] });
    const ref = { providerId: "typesafe", modelId: "jev-latest" };
    const fetchImpl = noNetwork();
    expect(await discoverJevModels(rt, { providerIds: ["typesafe"] }, fetchImpl)).toEqual([]);
    expect(registeredJevEndpoint(rt, ref)).toBeUndefined();
    await expect(resolveRegisteredJevConnection(rt, ref, fetchImpl)).rejects.toThrow("未検出");
  });

  it("discovers the built-in TypeSafe classifier catalog even though provider metadata has no URL", async () => {
    const rt = await runtime();
    rt.registerProvider("typesafe", { apiKey: "test-key" });
    expect(Object.getOwnPropertyDescriptor(rt.getProvider("typesafe")!, "baseUrl")?.value).toBeUndefined();
    expect(rt.getModels("typesafe")).toEqual([]);
    const native = rt.getAllModels("typesafe");
    expect(native.length).toBeGreaterThan(0);
    const fetchImpl = noNetwork();
    const models = await discoverJevModels(rt, { providerIds: ["typesafe"] }, fetchImpl);
    expect(models.map((model) => model.modelId)).toEqual(native.map((model) => model.id));
    expect((await resolveRegisteredJevConnection(rt, models[0], fetchImpl)).baseUrl).toBe("https://api.typesafe.ai/v1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retains credential-only TypeSafe discovery without adding chat models", async () => {
    const rt = await runtime();
    rt.registerProvider("typesafe", { apiKey: "test-key", models: [] });
    const fetchImpl = noNetwork();
    expect(await discoverJevModels(rt, { providerIds: ["typesafe"] }, fetchImpl)).toMatchObject([
      { providerId: "typesafe", modelId: "jev-latest", baseUrl: "https://api.typesafe.ai/v1" },
    ]);
    expect(rt.getModels("typesafe")).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
