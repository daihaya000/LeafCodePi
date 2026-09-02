import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  __resetProviderModelStateQueueForTests,
  accountModelKey,
  accountProviderModelKey,
  contextWindowForModel,
  ensureProviderModelsKnown,
  isModelDisabled,
  isProviderDisabled,
  providerModelStatePath,
  readProviderModelState,
  setProviderModelContextWindow,
  setProviderModelDisabled,
  setProviderModelOrder,
  sortByPreferredOrder,
} from "@/lib/provider-model-state";
import {
  buildProviderModelsCatalog,
  enabledModelOptionsFromCatalog,
  mergeIntegratedProviderRows,
} from "@/lib/provider-models";

const dirs: string[] = [];

afterEach(() => {
  __resetProviderModelStateQueueForTests();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.LEAFCODE_PI_DATA_DIR;
});

function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-pms-"));
  dirs.push(dir);
  process.env.LEAFCODE_PI_DATA_DIR = dir;
  return dir;
}

describe("provider-model-state", () => {
  it("persists disabled keys and order", async () => {
    const dir = tempDataDir();
    await setProviderModelDisabled("anthropic", true);
    await setProviderModelDisabled("openai-codex::gpt-5", true);
    await setProviderModelOrder({
      providerOrder: ["openai-codex", "anthropic"],
      modelOrder: { anthropic: ["claude-opus-4-5", "claude-sonnet-4-5"] },
    });
    const state = readProviderModelState(providerModelStatePath(dir));
    assert.equal(state.disabled.anthropic, true);
    assert.equal(state.disabled["openai-codex::gpt-5"], true);
    assert.deepEqual(state.providerOrder, ["openai-codex", "anthropic"]);
    assert.deepEqual(state.modelOrder.anthropic, ["claude-opus-4-5", "claude-sonnet-4-5"]);
    assert.equal(isProviderDisabled("anthropic", state), true);
    assert.equal(isModelDisabled("openai-codex", "gpt-5", state), true);
  });

  it("keeps account model settings independent from shared settings", async () => {
    const dir = tempDataDir();
    await setProviderModelDisabled("openai-codex", true, "acc-1");
    await setProviderModelDisabled("openai-codex::gpt-5", true, "acc-1");
    await setProviderModelOrder({
      modelOrder: {
        [accountProviderModelKey("openai-codex", "acc-1")]: ["gpt-4", "gpt-5"],
      },
    });

    const state = readProviderModelState(providerModelStatePath(dir));
    assert.equal(state.disabled[accountProviderModelKey("openai-codex", "acc-1")], true);
    assert.equal(state.disabled[accountModelKey("openai-codex", "gpt-5", "acc-1")], true);
    assert.equal(isProviderDisabled("openai-codex", state), false);
    assert.equal(isProviderDisabled("openai-codex", state, "acc-1"), true);
    assert.equal(isModelDisabled("openai-codex", "gpt-5", state), false);
    assert.equal(isModelDisabled("openai-codex", "gpt-5", state, "acc-1"), true);
    assert.deepEqual(
      state.modelOrder[accountProviderModelKey("openai-codex", "acc-1")],
      ["gpt-4", "gpt-5"],
    );
  });

  it("persists per-model context windows independently by account", async () => {
    const dir = tempDataDir();
    await setProviderModelContextWindow("openai-codex", "gpt-5", 65_536);
    await setProviderModelContextWindow("openai-codex", "gpt-5", 131_072, "acc-1");

    const state = readProviderModelState(providerModelStatePath(dir));
    assert.equal(contextWindowForModel("openai-codex", "gpt-5", state), 65_536);
    assert.equal(contextWindowForModel("openai-codex", "gpt-5", state, "acc-1"), 131_072);
    assert.equal(contextWindowForModel("openai-codex", "gpt-5", state, "acc-2"), 65_536);
  });

  it("sortByPreferredOrder keeps unknowns after preferred ids", () => {
    const sorted = sortByPreferredOrder(
      [{ id: "c" }, { id: "a" }, { id: "b" }],
      ["b", "a"],
      (item) => item.id,
    );
    assert.deepEqual(
      sorted.map((item) => item.id),
      ["b", "a", "c"],
    );
  });

  it("keeps known models enabled and disables newly discovered models", async () => {
    const dir = tempDataDir();
    const first = await ensureProviderModelsKnown([
      { providerID: "anthropic", modelID: "claude-sonnet" },
    ]);
    assert.equal(first.knownModels?.["anthropic::claude-sonnet"], true);
    assert.equal(first.disabled["anthropic::claude-sonnet"], undefined);

    const next = await ensureProviderModelsKnown([
      { providerID: "anthropic", modelID: "claude-sonnet" },
      { providerID: "anthropic", modelID: "claude-opus" },
    ]);
    assert.equal(next.disabled["anthropic::claude-sonnet"], undefined);
    assert.equal(next.disabled["anthropic::claude-opus"], true);
    assert.equal(
      readProviderModelState(providerModelStatePath(dir)).disabled[
        "anthropic::claude-opus"
      ],
      true,
    );
    const catalog = buildProviderModelsCatalog(
      {
        getProviders: () => [{ id: "anthropic", name: "Anthropic" }],
        getModels: () => [
          { id: "claude-sonnet", name: "Sonnet" },
          { id: "claude-opus", name: "Opus" },
        ],
        hasConfiguredAuth: () => true,
      },
      next,
    );
    assert.deepEqual(
      catalog[0]?.models.map(({ id, enabled }) => ({ id, enabled })),
      [
        { id: "claude-sonnet", enabled: true },
        { id: "claude-opus", enabled: false },
      ],
    );
  });
});

describe("buildProviderModelsCatalog", () => {
  it("only lists authenticated providers and applies enable/order", () => {
    const runtime = {
      getProviders: () => [
        { id: "anthropic", name: "Anthropic" },
        { id: "openai-codex", name: "OpenAI Codex" },
        { id: "opencode", name: "OpenCode Zen" },
      ],
      getModels: (providerId?: string) => {
        if (providerId === "anthropic") {
          return [
            { id: "claude-sonnet", name: "Sonnet" },
            { id: "claude-opus", name: "Opus" },
          ];
        }
        if (providerId === "openai-codex") {
          return [{ id: "gpt-5", name: "GPT-5" }];
        }
        return [{ id: "kimi", name: "Kimi" }];
      },
      hasConfiguredAuth: (providerId: string) =>
        providerId === "anthropic" || providerId === "openai-codex",
    };
    const catalog = buildProviderModelsCatalog(runtime, {
      disabled: { "anthropic::claude-sonnet": true },
      providerOrder: ["openai-codex", "anthropic"],
      modelOrder: { anthropic: ["claude-opus", "claude-sonnet"] },
    });
    assert.deepEqual(
      catalog.map((provider) => provider.id),
      ["openai-codex", "anthropic"],
    );
    assert.deepEqual(
      catalog[1].models.map((model) => model.id),
      ["claude-opus", "claude-sonnet"],
    );
    assert.equal(catalog[1].models[1].enabled, false);
    const enabled = enabledModelOptionsFromCatalog(catalog);
    assert.deepEqual(
      enabled.map((option) => option.value),
      ["openai-codex::gpt-5", "anthropic::claude-opus"],
    );
  });

  it("applies account-specific disabled and model order settings", () => {
    const runtime = {
      getProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
      getModels: () => [
        { id: "gpt-5", name: "GPT-5" },
        { id: "gpt-4", name: "GPT-4" },
      ],
      hasConfiguredAuth: () => true,
    };
    const catalog = buildProviderModelsCatalog(
      runtime,
      {
        disabled: { "acc-1::openai-codex::gpt-5": true },
        providerOrder: [],
        modelOrder: { "acc-1::openai-codex": ["gpt-4", "gpt-5"] },
      },
      "acc-1",
    );

    assert.equal(catalog[0].accountId, "acc-1");
    assert.deepEqual(
      catalog[0].models.map((model) => ({ id: model.id, enabled: model.enabled })),
      [
        { id: "gpt-4", enabled: true },
        { id: "gpt-5", enabled: false },
      ],
    );
  });

  it("merges account rows for integrated display", () => {
    const merged = mergeIntegratedProviderRows(
      [
        {
          id: "openai-codex",
          name: "OpenAI Codex",
          accountId: "acc-1",
          accountLabel: "仕事用",
          enabled: true,
          models: [
            { id: "gpt-5", name: "GPT-5", enabled: false },
            { id: "gpt-4", name: "GPT-4", enabled: true },
          ],
        },
        {
          id: "openai-codex",
          name: "OpenAI Codex",
          accountId: "acc-2",
          accountLabel: "個人用",
          enabled: false,
          models: [
            { id: "gpt-5", name: "GPT-5", enabled: true },
            { id: "gpt-3", name: "GPT-3", enabled: false },
          ],
        },
      ],
      {
        disabled: {},
        providerOrder: ["acc-2::openai-codex", "acc-1::openai-codex"],
        modelOrder: {},
      },
    );

    assert.deepEqual(merged, {
      id: "openai-codex",
      name: "OpenAI Codex",
      enabled: true,
      models: [
        { id: "gpt-5", name: "GPT-5", enabled: true },
        { id: "gpt-3", name: "GPT-3", enabled: false },
        { id: "gpt-4", name: "GPT-4", enabled: true },
      ],
    });
  });

  it("uses account row order for the unified provider list", () => {
    const runtime = {
      getProviders: () => [
        { id: "openai-codex", name: "OpenAI Codex" },
        { id: "anthropic", name: "Anthropic" },
      ],
      getModels: (providerId?: string) => [
        { id: providerId === "anthropic" ? "claude" : "gpt", name: "Model" },
      ],
      hasConfiguredAuth: () => true,
    };
    const catalog = buildProviderModelsCatalog(
      runtime,
      {
        disabled: {},
        providerOrder: ["acc-1::anthropic", "acc-1::openai-codex"],
        modelOrder: {},
      },
      "acc-1",
    );

    assert.deepEqual(
      catalog.map((provider) => provider.id),
      ["anthropic", "openai-codex"],
    );
  });
});
