import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createAccount } from "@/lib/accounts";
import {
  providerModelStatePath,
  readProviderModelState,
} from "@/lib/provider-model-state";
import { setAccountRoutingMode } from "@/lib/provider-routing";
import { AccountRuntimeManager } from "./account-runtime-manager";
import {
  getRuntimeFor,
  listModelsForAccounts,
  saveProviderModelsOrder,
  setProviderOrModelEnabled,
} from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";
const tempDirs: string[] = [];

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.LEAFCODE_PI_DATA_DIR;
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
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-models-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
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
      modelRuntime: {
        // 既定ランタイムのプロバイダ順: openai-codex を先頭に置き、アカウント別
        // モデルが他プロバイダと同じ位置へ挟まることを検証する。
        getProviders: () => [{ id: "openai-codex" }, { id: "llama-server" }],
      },
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
        { providerID: "openai-codex", accountId: "acc-1" },
        { providerID: "llama-server", accountId: undefined },
      ],
    );
  });

  it("merges account models into one option in integrated mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-routing-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const first = createAccount({ label: "仕事用", providers: ["openai-codex"] });
    const second = createAccount({ label: "個人用", providers: ["openai-codex"] });
    const makeRuntime = () => ({
      registerProvider: () => {},
      getProvider: () => undefined,
      getProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
      getModels: () => [{ id: "gpt-5", name: "GPT-5" }],
      getModel: (providerID: string, modelID: string) =>
        providerID === "openai-codex" && modelID === "gpt-5"
          ? { provider: providerID, id: modelID, input: ["text"], reasoning: false }
          : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: async () => [
        { provider: "openai-codex", id: "gpt-5", name: "GPT-5", input: ["text"], reasoning: false },
      ],
    });
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: {
        getProviders: () => [{ id: "openai-codex" }],
        modelCache: null,
      },
      modelCache: {
        at: Date.now(),
        value: [],
      },
      modelInflight: null,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(async () => makeRuntime() as never),
    };
    await setAccountRoutingMode("openai-codex", "integrated");

    const models = await listModelsForAccounts([
      { id: first.id, label: first.label, providers: first.providers },
      { id: second.id, label: second.label, providers: second.providers },
    ]);
    const options = models.filter((model) => model.providerID === "openai-codex");
    assert.equal(options.length, 1);
    assert.deepEqual(options[0], {
      value: "openai-codex::gpt-5",
      label: "GPT-5",
      providerID: "openai-codex",
      modelID: "gpt-5",
      input: ["text"],
      reasoning: false,
      thinkingLevels: [],
      codexbarUsedPercent: null,
      codexbarMaxed: false,
      routingMode: "integrated",
      routingCandidateCount: 2,
    });
  });

  it("saves enabled state and order in the account namespace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-models-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const account = createAccount({ label: "仕事用", providers: ["openai-codex"] });

    await setProviderOrModelEnabled("openai-codex::gpt-5", false, account.id);
    await saveProviderModelsOrder({
      accountModelOrder: {
        [account.id]: { "openai-codex": ["gpt-4", "gpt-5"] },
      },
    });

    const state = readProviderModelState(providerModelStatePath(dir));
    assert.equal(state.disabled[`${account.id}::openai-codex::gpt-5`], true);
    assert.deepEqual(
      state.modelOrder[`${account.id}::openai-codex`],
      ["gpt-4", "gpt-5"],
    );
    await assert.rejects(
      () => setProviderOrModelEnabled("anthropic", false, account.id),
      (error) => (error as { status?: number }).status === 400,
    );
    await assert.rejects(
      () => setProviderOrModelEnabled("openai-codex", false),
      (error) => (error as { status?: number }).status === 400,
    );
  });

  it("applies integrated model settings to every provider account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-integrated-models-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const first = createAccount({ label: "仕事用", providers: ["openai-codex"] });
    const second = createAccount({ label: "個人用", providers: ["openai-codex"] });

    await setAccountRoutingMode("openai-codex", "integrated");
    await setProviderOrModelEnabled("openai-codex::gpt-5", false);
    await saveProviderModelsOrder({
      modelOrder: { "openai-codex": ["gpt-4", "gpt-5"] },
    });

    const state = readProviderModelState(providerModelStatePath(dir));
    assert.equal(state.disabled[`${first.id}::openai-codex::gpt-5`], true);
    assert.equal(state.disabled[`${second.id}::openai-codex::gpt-5`], true);
    assert.deepEqual(
      state.modelOrder[`${first.id}::openai-codex`],
      ["gpt-4", "gpt-5"],
    );
    assert.deepEqual(
      state.modelOrder[`${second.id}::openai-codex`],
      ["gpt-4", "gpt-5"],
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
