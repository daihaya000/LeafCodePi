import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  __resetPiAgentDirCacheForTests,
  accountAuthPath,
  createAccount,
} from "@/lib/accounts";
import { parseCodexBarSnapshot } from "@/lib/codexbar";
import { clearCachedUsage, setCachedUsage } from "@/lib/codexbar/cache";
import { setAccountRoutingMode, __resetProviderRoutingQueueForTests } from "@/lib/provider-routing";
import { AccountRuntimeManager } from "./account-runtime-manager";
import { completeModelText } from "./harness";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const GLOBAL_KEY = "__leafcodePiHarness";
const tempDirs: string[] = [];
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;

function useTestAgentDir(dir: string): string {
  const agentDir = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  __resetPiAgentDirCacheForTests();
  return agentDir;
}

function storeAccountProviderAuth(accountId: string, agentDir: string): void {
  const authPath = accountAuthPath(accountId, agentDir);
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(
    authPath,
    JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }),
    "utf8",
  );
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-complete-test-"));
  tempDirs.push(dir);
  process.env.LEAFCODE_PI_DATA_DIR = dir;
  useTestAgentDir(dir);
});

/** completeModelText は state().modelRuntime 経由で Pi ランタイムを使うため、
 *  グローバル state にスタブを注入して実装を直接検証する。
 *  getProvider を truthy にして任意プロバイダー登録（ensureOptionalProviders）をスキップさせる。 */
function installRuntime(response: AssistantMessage) {
  const calls: unknown[] = [];
  const runtime = {
    getProvider: () => ({ id: "stub" }),
    getModel: (providerID: string, modelID: string) =>
      providerID === "anthropic" && (modelID === "claude-sonnet" || modelID === "reasoning-model")
        ? { id: modelID, provider: providerID, api: "anthropic-messages", reasoning: modelID === "reasoning-model", maxTokens: 32_768 }
        : providerID === "openai-codex" && (modelID === "codex-model" || modelID === "codex-legacy")
          ? { id: modelID, provider: providerID, api: modelID === "codex-model" ? "openai-codex-responses" : "openai-responses", reasoning: true, maxTokens: 32_768 }
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
  clearCachedUsage();
  __resetProviderRoutingQueueForTests();
  delete process.env.LEAFCODE_PI_DATA_DIR;
  if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  __resetPiAgentDirCacheForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

  it("omits temperature for every Codex model, including legacy API labels", async () => {
    const calls = installRuntime(
      assistant({ content: [{ type: "text", text: "ok" }] }),
    );

    await completeModelText({
      providerID: "openai-codex",
      modelID: "codex-legacy",
      system: "system",
      prompt: "prompt",
      temperature: 0,
    });

    const requestOptions = (calls[0] as unknown[] | undefined)?.[2] as {
      temperature?: number;
    };
    assert.equal(requestOptions.temperature, undefined);
  });

  it("routes an integrated model to the account with lower cached usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-complete-routing-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = useTestAgentDir(dir);
    const high = createAccount({ label: "使用量大", providers: ["anthropic"] });
    const low = createAccount({ label: "使用量小", providers: ["anthropic"] });
    const unrelated = createAccount({ label: "別プロバイダー", providers: ["openai-codex"] });
    storeAccountProviderAuth(high.id, agentDir);
    storeAccountProviderAuth(low.id, agentDir);
    await setAccountRoutingMode("anthropic", "integrated");
    setCachedUsage(
      parseCodexBarSnapshot({
        providers: [
          { codexBarProviderId: "anthropic", accountId: high.id, usedPercent: 80 },
          { codexBarProviderId: "anthropic", accountId: low.id, usedPercent: 20 },
        ],
      }),
    );

    const calls: string[] = [];
    const response = assistant({ content: [{ type: "text", text: "提案" }] });
    const makeRuntime = (accountId: string) => ({
      getProvider: () => ({ id: "stub" }),
      registerProvider: () => {},
      getProviders: () => [{ id: "anthropic", name: "Anthropic" }],
      getModels: () => [{ id: "claude-sonnet", name: "Claude Sonnet" }],
      hasConfiguredAuth: () => true,
      getAvailable: async () => [
        {
          provider: "anthropic",
          id: "claude-sonnet",
          name: "Claude Sonnet",
          input: ["text"],
          reasoning: false,
          thinkingLevelMap: { off: "none" },
        },
      ],
      getModel: (providerID: string, modelID: string) =>
        providerID === "anthropic" && modelID === "claude-sonnet"
          ? {
              provider: providerID,
              id: modelID,
              reasoning: false,
              thinkingLevelMap: { off: "none" },
              maxTokens: 32_768,
            }
          : undefined,
      completeSimple: () => {
        calls.push(accountId);
        return Promise.resolve(response);
      },
    });
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      pi: null,
      modelRuntime: { getProvider: () => ({ id: "stub" }), registerProvider: () => {} },
      accountRuntimes: new AccountRuntimeManager(async (accountId) => makeRuntime(accountId) as never),
      initPromise: null,
      initError: null,
      live: new Map(),
      watchdogRegistered: true,
      lastProviderSyncWarnings: [],
    };

    await assert.equal(
      await completeModelText({
        providerID: "anthropic",
        modelID: "claude-sonnet",
        system: "system",
        prompt: "prompt",
      }),
      "提案",
    );
    assert.deepEqual(calls, [low.id]);

    calls.length = 0;
    await completeModelText({
      providerID: "anthropic",
      modelID: "claude-sonnet",
      accountId: unrelated.id,
      system: "system",
      prompt: "prompt",
    });
    assert.deepEqual(calls, [low.id]);
  });

  it("holds an account runtime while direct completion is in flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-complete-lease-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = useTestAgentDir(dir);
    const account = createAccount({ label: "専用", providers: ["anthropic"] });
    storeAccountProviderAuth(account.id, agentDir);
    const response = assistant({ content: [{ type: "text", text: "提案" }] });
    const manager = new AccountRuntimeManager(async () => runtime as never, 0);
    const runtime = {
      getProvider: () => ({ id: "stub" }),
      getProviders: () => [{ id: "anthropic", name: "Anthropic" }],
      getModels: () => [{ id: "claude-sonnet", name: "Claude Sonnet" }],
      hasConfiguredAuth: () => true,
      getAvailable: async () => [
        {
          provider: "anthropic",
          id: "claude-sonnet",
          name: "Claude Sonnet",
          input: ["text"],
          reasoning: false,
          thinkingLevelMap: { off: "none" },
        },
      ],
      getModel: (providerID: string, modelID: string) =>
        providerID === "anthropic" && modelID === "claude-sonnet"
          ? { provider: providerID, id: modelID, reasoning: false, maxTokens: 32_768 }
          : undefined,
      completeSimple: async () => {
        manager.evictIdle();
        assert.ok(manager.peek(account.id));
        return response;
      },
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      pi: null,
      modelRuntime: { getProvider: () => ({ id: "stub" }), registerProvider: () => {} },
      accountRuntimes: manager,
      initPromise: null,
      initError: null,
      live: new Map(),
      watchdogRegistered: true,
      lastProviderSyncWarnings: [],
    };

    await assert.equal(
      await completeModelText({
        providerID: "anthropic",
        modelID: "claude-sonnet",
        accountId: account.id,
        system: "system",
        prompt: "prompt",
      }),
      "提案",
    );
    manager.evictIdle();
    assert.equal(manager.peek(account.id), undefined);
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

  it("crosses to another provider when the primary returns a 429 limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-complete-fallback-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = useTestAgentDir(dir);
    const anthropic = createAccount({ label: "Claude", providers: ["anthropic"] });
    const codex = createAccount({ label: "Codex", providers: ["openai-codex"] });
    storeAccountProviderAuth(anthropic.id, agentDir);
    const codexAuthPath = accountAuthPath(codex.id, agentDir);
    mkdirSync(dirname(codexAuthPath), { recursive: true });
    writeFileSync(
      codexAuthPath,
      JSON.stringify({ "openai-codex": { type: "api_key", key: "test-key" } }),
      "utf8",
    );

    const calls: string[] = [];
    const success = assistant({ content: [{ type: "text", text: "代替" }] });
    const makeAccountRuntime = (accountId: string, providerID: string, modelID: string) => ({
      getProvider: () => ({ id: "stub" }),
      registerProvider: () => {},
      getProviders: () => [{ id: providerID, name: providerID }],
      getModels: () => [{ id: modelID, name: modelID }],
      hasConfiguredAuth: () => true,
      getAvailable: async () => [
        { provider: providerID, id: modelID, name: modelID, input: ["text"], reasoning: false },
      ],
      getModel: (provider: string, model: string) =>
        provider === providerID && model === modelID
          ? { provider, id: model, reasoning: false, maxTokens: 32_768 }
          : undefined,
      completeSimple: async () => {
        calls.push(accountId);
        return success;
      },
    });
    const limitRuntime = {
      getProvider: () => ({ id: "stub" }),
      getModel: (providerID: string, modelID: string) =>
        providerID === "anthropic" && modelID === "claude-sonnet"
          ? {
              id: modelID,
              provider: providerID,
              api: "anthropic-messages",
              reasoning: false,
              maxTokens: 32_768,
            }
          : undefined,
      completeSimple: async () => {
        calls.push("default");
        throw Object.assign(new Error("429 Monthly usage limit reached"), { status: 429 });
      },
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      pi: null,
      modelRuntime: limitRuntime,
      accountRuntimes: new AccountRuntimeManager(
        async (accountId) =>
          (accountId === anthropic.id
            ? makeAccountRuntime(anthropic.id, "anthropic", "claude-sonnet")
            : makeAccountRuntime(codex.id, "openai-codex", "codex-model")) as never,
      ),
      initPromise: null,
      initError: null,
      live: new Map(),
      watchdogRegistered: true,
      lastProviderSyncWarnings: [],
    };

    await assert.equal(
      await completeModelText({
        providerID: "anthropic",
        modelID: "claude-sonnet",
        system: "system",
        prompt: "prompt",
      }),
      "代替",
    );
    assert.deepEqual(calls, ["default", codex.id]);
  });
});
