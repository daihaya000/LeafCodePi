import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  __resetProviderModelStateQueueForTests,
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
});
