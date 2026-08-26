import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  __resetProviderModelStateQueueForTests,
  accountModelKey,
  accountProviderModelKey,
  isModelDisabled,
  isProviderDisabled,
  providerModelStatePath,
  readProviderModelState,
  setProviderModelDisabled,
  setProviderModelOrder,
  sortByPreferredOrder,
} from "@/lib/provider-model-state";
import {
  buildProviderModelsCatalog,
  enabledModelOptionsFromCatalog,
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
});
