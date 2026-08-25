import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { completeModelText } from "./harness";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const GLOBAL_KEY = "__leafcodePiHarness";

/** completeModelText は state().modelRuntime 経由で Pi ランタイムを使うため、
 *  グローバル state にスタブを注入して実装を直接検証する。
 *  getProvider を truthy にして任意プロバイダー登録（ensureOptionalProviders）をスキップさせる。 */
function installRuntime(response: AssistantMessage) {
  const calls: unknown[] = [];
  const runtime = {
    getProvider: () => ({ id: "stub" }),
    getModel: (providerID: string, modelID: string) =>
      providerID === "anthropic" && (modelID === "claude-sonnet" || modelID === "reasoning-model")
        ? { id: modelID, provider: providerID, reasoning: modelID === "reasoning-model", maxTokens: 32_768 }
        : undefined,
    completeSimple: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(response);
    },
  };
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    pi: null,
    modelRuntime: runtime,
    initPromise: null,
    initError: null,
    live: new Map(),
    watchdogRegistered: true,
    lastProviderSyncWarnings: [],
  };
  return calls;
}

function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet",
    usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    content: [],
    timestamp: Date.now(),
    ...overrides,
  } as AssistantMessage;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
});

describe("completeModelText", () => {
  it("returns text on success", async () => {
    installRuntime(
      assistant({ content: [{ type: "text", text: " 更新 foo " }] }),
    );
    await assert.equal(
      await completeModelText({
        providerID: "anthropic",
        modelID: "claude-sonnet",
        system: "system",
        prompt: "prompt",
      }),
      "更新 foo",
    );
  });

  it("leaves room for an answer when a reasoning model is used", async () => {
    const calls = installRuntime(
      assistant({ content: [{ type: "text", text: "提案" }] }),
    );
    await completeModelText({
      providerID: "anthropic",
      modelID: "reasoning-model",
      system: "system",
      prompt: "prompt",
      maxTokens: 180,
      reasoning: "minimal",
    });

    const requestOptions = (calls[0] as unknown[] | undefined)?.[2] as { maxTokens?: number };
    assert.equal(requestOptions.maxTokens, 1_204);

    const defaultCalls = installRuntime(
      assistant({ content: [{ type: "text", text: "提案" }] }),
    );
    await completeModelText({
      providerID: "anthropic",
      modelID: "reasoning-model",
      system: "system",
      prompt: "prompt",
      maxTokens: 180,
    });
    const defaultOptions = (defaultCalls[0] as unknown[] | undefined)?.[2] as { maxTokens?: number };
    assert.equal(defaultOptions.maxTokens, 8_372);
  });

  it("propagates the provider errorMessage instead of a generic no-text error", async () => {
    installRuntime(
      assistant({ stopReason: "error", errorMessage: "401 invalid api key" }),
    );
    await assert.rejects(
      completeModelText({
        providerID: "anthropic",
        modelID: "claude-sonnet",
        system: "system",
        prompt: "prompt",
      }),
      /401 invalid api key/,
    );
  });

  it("falls back to a Japanese message for error/aborted without errorMessage", async () => {
    installRuntime(assistant({ stopReason: "error" }));
    await assert.rejects(
      completeModelText({
        providerID: "anthropic",
        modelID: "claude-sonnet",
        system: "system",
        prompt: "prompt",
      }),
      /生成が失敗しました/,
    );

    installRuntime(assistant({ stopReason: "aborted" }));
    await assert.rejects(
      completeModelText({
        providerID: "anthropic",
        modelID: "claude-sonnet",
        system: "system",
        prompt: "prompt",
      }),
      /生成が中断しました/,
    );
  });
});
