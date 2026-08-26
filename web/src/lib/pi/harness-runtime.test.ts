import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { AccountRuntimeManager } from "./account-runtime-manager";
import { getRuntimeFor, listModelsForAccounts } from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
});

describe("getRuntimeFor", () => {
  it("returns the default singleton when no accountId is given", async () => {
    const stub = { id: "default-runtime" };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: stub,
      live: new Map(),
      lastProviderSyncWarnings: [],
    };
    assert.equal(await getRuntimeFor(), stub);
    assert.equal(await getRuntimeFor(undefined), stub);
    assert.equal(await getRuntimeFor(null), stub);
  });

  it("resolves account runtimes through the manager", async () => {
    const defaultStub = { id: "default-runtime" };
    const accountStub = { id: "account-runtime" };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: defaultStub,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(async () => accountStub as never),
    };
    // 既定と分離され、同一アカウントはマネージャ経由で再利用される
    assert.equal(await getRuntimeFor("acc-1"), accountStub);
    assert.equal(await getRuntimeFor("acc-1"), accountStub);
    assert.notEqual(await getRuntimeFor("acc-1"), defaultStub);
    // accountId 未指定は既定のまま
    assert.equal(await getRuntimeFor(), defaultStub);
  });

  it("hides default subscription models while keeping account models", async () => {
    const accountRuntime = {
      registerProvider: () => {},
      getProvider: () => undefined,
      getProviders: () => [
        { id: "openai-codex", name: "OpenAI Codex" },
        { id: "llama-server", name: "llama-server" },
      ],
      getModels: (providerId?: string) =>
        providerId === "openai-codex"
          ? [{ id: "gpt-5", name: "GPT-5" }]
          : [{ id: "local", name: "Local" }],
      hasConfiguredAuth: () => true,
      getAvailable: async () => [
        { provider: "openai-codex", id: "gpt-5", name: "GPT-5", input: ["text"], reasoning: false },
        { provider: "llama-server", id: "local", name: "Local", input: ["text"], reasoning: false },
      ],
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: null,
      modelCache: {
        at: Date.now(),
        value: [
          { value: "openai-codex::gpt-5", label: "GPT-5", providerID: "openai-codex", modelID: "gpt-5" },
          { value: "anthropic::claude", label: "Claude", providerID: "anthropic", modelID: "claude" },
          { value: "llama-server::local", label: "Local", providerID: "llama-server", modelID: "local" },
        ],
      },
      modelInflight: null,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(async () => accountRuntime as never),
    };

    const models = await listModelsForAccounts([
      { id: "acc-1", label: "仕事用", providers: ["openai-codex"] },
    ]);

    assert.deepEqual(
      models.map((model) => ({ providerID: model.providerID, accountId: model.accountId })),
      [
        { providerID: "llama-server", accountId: undefined },
        { providerID: "openai-codex", accountId: "acc-1" },
      ],
    );
  });

  it("returns null before the runtime is initialized", async () => {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: null,
      live: new Map(),
      lastProviderSyncWarnings: [],
    };
    assert.equal(await getRuntimeFor(), null);
  });
});
