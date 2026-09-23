import { beforeEach, describe, expect, it, vi } from "vitest";
import { isJevModel, jevModelKey, supportsJevModel } from "@/lib/jev-model-catalog";
import { buildProviderModelsCatalog, enabledModelOptionsFromCatalog } from "@/lib/provider-models";
import { clearJevDiscoveryCache, discoverJevModels, type JevDiscoveryRuntime } from "./jev-model-discovery";

const jev = { id: "typesafe/jev-1.13", name: "Jev 1.13", architecture: { output_modalities: ["decisions"] } };
const alias = { id: "~typesafe/jev-latest", name: "Jev Latest" };
const provider = { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" };
function runtime(models: Array<{ id: string; name?: string }> = []): JevDiscoveryRuntime {
  return { getProviders: () => [provider], getModels: () => models, checkAuth: async () => ({ type: "api_key" }) };
}
const reply = (models: unknown[]) => vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: models })));
beforeEach(clearJevDiscoveryCache);

describe("Jev discovery", () => {
  it("supplements the chat catalog with OpenRouter's decisions catalog without sending credentials", async () => {
    const fetchImpl = reply([jev, alias, { id: "ordinary-chat" }]);
    const models = await discoverJevModels(runtime([jev]), { accountId: "account-1", accountLabel: "Main" }, fetchImpl);
    expect(models.map((model) => model.modelId)).toEqual([jev.id, alias.id]);
    expect(models[0]).toMatchObject({ providerId: "openrouter", accountId: "account-1", baseUrl: provider.baseUrl, source: "catalog" });
    expect(fetchImpl).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models?output_modalities=decisions&limit=1000", expect.objectContaining({ redirect: "error" }));
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty("headers");
    expect(jevModelKey(models[0])).not.toBe(jevModelKey({ ...models[0], accountId: "account-2" }));
  });

  it("shares in-flight public catalogs across accounts and supports explicit refresh", async () => {
    const fetchImpl = reply([jev]);
    await Promise.all([
      discoverJevModels(runtime(), { accountId: "one" }, fetchImpl),
      discoverJevModels(runtime(), { accountId: "two" }, fetchImpl),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await discoverJevModels(runtime(), {}, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clearJevDiscoveryCache();
    await discoverJevModels(runtime(), {}, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps CommandCode's separately documented Jev available even when the chat catalog omits it", async () => {
    const rt = { ...runtime(), getProviders: () => [{ id: "commandcode", name: "Command Code", baseUrl: "https://api.commandcode.ai" }] };
    const fetchImpl = reply([{ id: "chat-model" }]);
    expect(await discoverJevModels(rt, {}, fetchImpl)).toEqual([{
      providerId: "commandcode", providerName: "Command Code", modelId: "typesafe/jev", name: "Jev",
      baseUrl: "https://api.commandcode.ai/provider/v1", source: "documented",
    }]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.commandcode.ai/provider/v1/models");
  });

  it("finds TypeSafe through the shared provider credential without adding a chat model", async () => {
    const rt = { ...runtime(), getProviders: () => [{ id: "typesafe", name: "TypeSafe", baseUrl: "https://api.typesafe.ai/v1" }] };
    expect(await discoverJevModels(rt, {}, reply([]))).toEqual([{
      providerId: "typesafe", providerName: "TypeSafe", modelId: "jev-latest", name: "Jev",
      baseUrl: "https://api.typesafe.ai/v1", source: "documented",
    }]);
  });

  it("does not infer another provider's API format solely from a Jev name", async () => {
    const models = [jev, { id: "my-judge", supported_endpoints: ["/v1/systemone"] }];
    const rt = { ...runtime(models), getProviders: () => [{ id: "custom", name: "Custom", baseUrl: "http://localhost:8000/v1" }] };
    const fetchImpl = reply([]);
    expect((await discoverJevModels(rt, {}, fetchImpl)).map((model) => model.modelId)).toEqual(["my-judge"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(supportsJevModel("custom", jev)).toBe(false);
  });

  it("does not query unconfigured or out-of-scope providers", async () => {
    const fetchImpl = reply([jev]);
    expect(await discoverJevModels({ ...runtime(), checkAuth: async () => undefined }, {}, fetchImpl)).toEqual([]);
    expect(await discoverJevModels(runtime(), { providerIds: ["commandcode"] }, fetchImpl)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retains native candidates on network failure and ignores advertised credential destinations", async () => {
    const models = await discoverJevModels(runtime(), {}, reply([{ ...jev, baseUrl: "https://untrusted.example" }]));
    expect(models[0].baseUrl).toBe(provider.baseUrl);
    clearJevDiscoveryCache();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    expect((await discoverJevModels(runtime([jev]), {}, fetchImpl))[0].modelId).toBe(jev.id);
  });

  it("isolates broken providers and rejects invalid bases", async () => {
    const rt = { ...runtime([jev]), getProviders: () => [provider, { ...provider, id: "commandcode", baseUrl: "https://user:password@example.com" }], checkAuth: async (id: string) => { if (id === "openrouter") throw new Error("broken"); return {}; } };
    const fetchImpl = reply([]);
    expect(await discoverJevModels(rt, {}, fetchImpl)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("excludes decision models from the normal catalog and Composer options", () => {
    const models = [jev, alias, { id: "custom-judge", api: "systemone" }, { id: "chat", name: "Chat" }, { id: "jevil", name: "Not Jev" }];
    expect(models.map(isJevModel)).toEqual([true, true, true, false, false]);
    const catalog = buildProviderModelsCatalog({ ...runtime(models), hasConfiguredAuth: () => true }, { disabled: {}, providerOrder: [], modelOrder: {} });
    expect(enabledModelOptionsFromCatalog(catalog).map((model) => model.modelID)).toEqual(["chat", "jevil"]);
  });
});
