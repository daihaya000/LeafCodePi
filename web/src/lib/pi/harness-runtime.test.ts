import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  __resetPiAgentDirCacheForTests,
  accountAuthPath,
  createAccount,
  type AccountRecord,
} from "@/lib/accounts";
import {
  providerModelStatePath,
  readProviderModelState,
} from "@/lib/provider-model-state";
import {
  __resetProviderRoutingQueueForTests,
  setAccountRoutingMode,
  markProviderLimited,
} from "@/lib/provider-routing";
import {
  autoProviderUsageFromModels,
  chooseAutoModel,
} from "@/lib/auto-model";
import { AccountRuntimeManager } from "./account-runtime-manager";
import {
  getHealth,
  getRuntimeFor,
  invalidateHealthCache,
  listProviderAuth,
  listProviderModelsCatalog,
  listModelsForAccounts,
  saveProviderModelsOrder,
  setProviderOrModelEnabled,
} from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";
const tempDirs: string[] = [];
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;

function useTestAgentDir(dir: string): string {
  const agentDir = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  __resetPiAgentDirCacheForTests();
  return agentDir;
}

function storeAccountProviderAuth(
  account: Pick<AccountRecord, "id">,
  agentDir: string,
  providerId: string,
): void {
  const authPath = accountAuthPath(account.id, agentDir);
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(
    authPath,
    JSON.stringify({ [providerId]: { type: "api_key", key: "test-key" } }),
    "utf8",
  );
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  __resetProviderRoutingQueueForTests();
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  delete process.env.LEAFCODE_PI_DATA_DIR;
  if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  __resetPiAgentDirCacheForTests();
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

  it("exposes usage-only OpenCode Go in the provider list", async () => {
    // 実環境の provider-routing.json（統合モード設定）に依存しないよう分離する。
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-provider-list-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const optionalProviderIds = new Set([
      "cursor",
      "commandcode",
      "ollama-cloud",
    ]);
    const runtime = {
      getProvider: (id: string) =>
        optionalProviderIds.has(id) ? { id } : undefined,
      getProviders: () => [],
      registerProvider: () => undefined,
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: runtime,
      initPromise: null,
      watchdogRegistered: true,
      live: new Map(),
      lastProviderSyncWarnings: [],
    };

    const provider = (await listProviderAuth()).find(
      (item) => item.id === "opencode-go",
    );
    assert.deepEqual(provider, {
      id: "opencode-go",
      name: "OpenCode Go",
      authenticated: false,
      methods: [],
      authSource: undefined,
      authLabel: undefined,
      subscription: false,
      oauthAvailable: false,
      highlighted: true,
      accountRoutingMode: "separate",
    });
  });

  it("resolves account runtimes through the manager", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-runtime-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const account = createAccount({
      label: "テスト",
      providers: ["openai-codex"],
    });
    const defaultStub = { id: "default-runtime" };
    const accountStub = { id: "account-runtime" };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: defaultStub,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(
        async () => accountStub as never,
      ),
    };
    // 既定と分離され、同一アカウントはマネージャ経由で再利用される
    assert.equal(await getRuntimeFor(account.id), accountStub);
    assert.equal(await getRuntimeFor(account.id), accountStub);
    assert.notEqual(await getRuntimeFor(account.id), defaultStub);
    // accountId 未指定は既定のまま
    assert.equal(await getRuntimeFor(), defaultStub);
  });

  it("coalesces concurrent provider catalog reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-provider-catalog-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    let modelReads = 0;
    const runtime = {
      getProvider: (id: string) => ({ id }),
      getProviders: () => [{ id: "llama-server", name: "llama-server" }],
      getModels: () => {
        modelReads += 1;
        return [{ id: "local", name: "Local" }];
      },
      hasConfiguredAuth: () => true,
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: runtime,
      initPromise: null,
      initError: null,
      live: new Map(),
      watchdogRegistered: true,
      lastProviderSyncWarnings: [],
    };

    const [first, second] = await Promise.all([
      listProviderModelsCatalog(),
      listProviderModelsCatalog(),
    ]);

    assert.deepEqual(second, first);
    assert.equal(modelReads, 1);
  });

  it("rejects unknown account ids before creating a runtime", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "leafcode-pi-harness-missing-account-"),
    );
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    let creations = 0;
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: { id: "default-runtime" },
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(async () => {
        creations += 1;
        return { id: "account-runtime" } as never;
      }),
    };

    await assert.rejects(
      () => getRuntimeFor("missing"),
      (error) => (error as { status?: number }).status === 404,
    );
    assert.equal(creations, 0);
  });

  it("uses stored account auth for cold health without creating account runtimes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-health-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    __resetPiAgentDirCacheForTests();
    const account = createAccount({
      label: "仕事用",
      providers: ["openai-codex"],
    });
    const authPath = accountAuthPath(account.id, agentDir);
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(
      authPath,
      JSON.stringify({ "openai-codex": { type: "oauth" } }),
      "utf8",
    );
    let creations = 0;
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      pi: null,
      modelRuntime: { getProvider: (id: string) => ({ id }) },
      accountRuntimes: new AccountRuntimeManager(async () => {
        creations += 1;
        return "unused" as never;
      }),
      initError: null,
      initPromise: null,
      live: new Map(),
      healthCache: null,
      modelCache: { at: Date.now(), value: [] },
      modelInflight: null,
      accountModelCache: null,
      accountModelInflight: null,
      watchdogRegistered: true,
      lastProviderSyncWarnings: [],
    };

    const health = await getHealth();

    assert.equal(health.engineOk, true);
    assert.equal(health.modelCount, 0);
    assert.equal(creations, 0);
  });

  it("uses the combined model cache for health without rereading runtime models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-health-cache-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    let availableReads = 0;
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      pi: null,
      modelRuntime: {
        getAvailable: async () => {
          availableReads += 1;
          return [];
        },
      },
      accountRuntimes: null,
      initError: null,
      initPromise: null,
      live: new Map(),
      healthCache: null,
      modelCache: null,
      modelInflight: null,
      accountModelCache: {
        key: "[]",
        at: Date.now(),
        value: [
          {
            value: "openai/gpt-5",
            label: "GPT-5",
            providerID: "openai",
            modelID: "gpt-5",
            input: ["text"],
            reasoning: false,
            thinkingLevels: [],
          },
        ],
      },
      accountModelInflight: null,
      watchdogRegistered: true,
      lastProviderSyncWarnings: [],
    };

    const health = await getHealth();

    assert.equal(health.modelCount, 1);
    assert.equal(availableReads, 0);
  });

  it("serves stale account models while revalidating in the background", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-models-swr-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const staleOption = {
      value: "llama-server::stale",
      label: "Stale",
      providerID: "llama-server",
      modelID: "stale",
      input: ["text"] as ("text")[],
      reasoning: false,
    };
    const freshOption = {
      value: "llama-server::fresh",
      label: "Fresh",
      providerID: "llama-server",
      modelID: "fresh",
      input: ["text"] as ("text")[],
      reasoning: false,
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      pi: null,
      modelRuntime: null,
      accountRuntimes: null,
      initError: null,
      initPromise: null,
      live: new Map(),
      healthCache: null,
      // 共有側の候補は新鮪キープ（再構築の内実はこの値が流れる）。
      modelCache: { at: Date.now(), value: [freshOption] },
      modelInflight: null,
      accountModelCache: {
        key: "[]",
        // TTL(15s)を過ぎたが SWR 提供範囲(5分)内の旧一覧。
        at: Date.now() - 20_000,
        value: [staleOption],
      },
      accountModelInflight: null,
      watchdogRegistered: true,
      lastProviderSyncWarnings: [],
    };

    const accounts: Pick<AccountRecord, "id" | "label" | "providers">[] = [];

    // 即時返しは旧値。この時点で裏の再構築が走っている。
    const served = await listModelsForAccounts(accounts);
    assert.deepEqual(served, [staleOption]);

    const inflight = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as {
      accountModelInflight: { promise: Promise<unknown> } | null;
    };
    assert.ok(inflight.accountModelInflight);
    await inflight.accountModelInflight!.promise;

    // 裏の再構築完了後は新しい一覧が返る。
    const refreshed = await listModelsForAccounts(accounts);
    assert.deepEqual(refreshed, [freshOption]);
  });

  it("hides default subscription models while keeping account models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-models-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = useTestAgentDir(dir);
    const availableProviders: (string | undefined)[] = [];
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
      getAvailable: async (providerId?: string) => {
        availableProviders.push(providerId);
        return providerId === "openai-codex"
          ? [
              {
                provider: "openai-codex",
                id: "gpt-5",
                name: "GPT-5",
                input: ["text"],
                reasoning: false,
              },
            ]
          : [
              {
                provider: "openai-codex",
                id: "gpt-5",
                name: "GPT-5",
                input: ["text"],
                reasoning: false,
              },
              {
                provider: "llama-server",
                id: "local",
                name: "Local",
                input: ["text"],
                reasoning: false,
              },
            ];
      },
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
          {
            value: "openai-codex::gpt-5",
            label: "GPT-5",
            providerID: "openai-codex",
            modelID: "gpt-5",
          },
          {
            value: "anthropic::claude",
            label: "Claude",
            providerID: "anthropic",
            modelID: "claude",
          },
          {
            value: "llama-server::local",
            label: "Local",
            providerID: "llama-server",
            modelID: "local",
          },
        ],
      },
      modelInflight: null,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(
        async () => accountRuntime as never,
      ),
    };

    const account = createAccount({
      label: "仕事用",
      providers: ["openai-codex"],
    });
    storeAccountProviderAuth(account, agentDir, "openai-codex");
    const accounts: Pick<AccountRecord, "id" | "label" | "providers">[] = [
      account,
    ];
    const [models, duplicate] = await Promise.all([
      listModelsForAccounts(accounts),
      listModelsForAccounts(accounts),
    ]);

    assert.deepEqual(duplicate, models);
    assert.deepEqual(availableProviders, ["openai-codex"]);
    assert.deepEqual(
      models.map((model) => ({
        providerID: model.providerID,
        accountId: model.accountId,
      })),
      [
        { providerID: "openai-codex", accountId: account.id },
        { providerID: "llama-server", accountId: undefined },
      ],
    );
  });

  it("hides default account-provider models without a matching account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-keydefault-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = useTestAgentDir(dir);
    const accountRuntime = {
      registerProvider: () => {},
      getProvider: () => undefined,
      getProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
      getModels: () => [{ id: "gpt-5", name: "GPT-5" }],
      hasConfiguredAuth: () => true,
      getAvailable: async () => [
        {
          provider: "openai-codex",
          id: "gpt-5",
          name: "GPT-5",
          input: ["text"],
          reasoning: false,
        },
      ],
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: {
        getProviders: () => [{ id: "openai-codex" }, { id: "ollama-cloud" }],
      },
      modelCache: {
        at: Date.now(),
        value: [
          {
            value: "openai-codex::gpt-5",
            label: "GPT-5",
            providerID: "openai-codex",
            modelID: "gpt-5",
          },
          {
            value: "ollama-cloud::glm-4.6",
            label: "GLM",
            providerID: "ollama-cloud",
            modelID: "glm-4.6",
          },
        ],
      },
      modelInflight: null,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(
        async () => accountRuntime as never,
      ),
    };

    const account = createAccount({
      label: "仕事用",
      providers: ["openai-codex"],
    });
    storeAccountProviderAuth(account, agentDir, "openai-codex");
    const models = await listModelsForAccounts([account]);

    // アカウント対応プロバイダーは、該当アカウントが無い場合も既定候補を出さない。
    assert.deepEqual(
      models.map((model) => ({
        providerID: model.providerID,
        accountId: model.accountId,
      })),
      [{ providerID: "openai-codex", accountId: account.id }],
    );
  });

  it("hides default account-provider models once that provider has an account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-keyaccount-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = useTestAgentDir(dir);
    const requested: (string | undefined)[] = [];
    const accountRuntime = {
      registerProvider: () => {},
      getProvider: () => undefined,
      getProviders: () => [{ id: "ollama-cloud", name: "Ollama Cloud" }],
      getModels: () => [{ id: "glm-4.6", name: "GLM" }],
      hasConfiguredAuth: () => true,
      getAvailable: async (providerId?: string) => {
        requested.push(providerId);
        return [
          {
            provider: "ollama-cloud",
            id: "glm-4.6",
            name: "GLM",
            input: ["text"],
            reasoning: false,
          },
        ];
      },
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: {
        getProviders: () => [{ id: "ollama-cloud" }, { id: "llama-server" }],
      },
      modelCache: {
        at: Date.now(),
        value: [
          {
            value: "ollama-cloud::glm-4.6",
            label: "GLM",
            providerID: "ollama-cloud",
            modelID: "glm-4.6",
          },
          {
            value: "llama-server::local",
            label: "Local",
            providerID: "llama-server",
            modelID: "local",
          },
        ],
      },
      modelInflight: null,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(
        async () => accountRuntime as never,
      ),
    };

    const account = createAccount({
      label: "個人用",
      providers: ["ollama-cloud"],
    });
    storeAccountProviderAuth(account, agentDir, "ollama-cloud");
    const models = await listModelsForAccounts([account]);

    assert.deepEqual(requested, ["ollama-cloud"]);
    assert.deepEqual(
      models.map((model) => ({
        providerID: model.providerID,
        accountId: model.accountId,
      })),
      [
        { providerID: "ollama-cloud", accountId: account.id },
        { providerID: "llama-server", accountId: undefined },
      ],
    );
  });

  it("does not expose ambient API-key models in an account without stored auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-ambient-key-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    useTestAgentDir(dir);
    const accountRuntime = {
      registerProvider: () => {},
      getProvider: () => undefined,
      getProviders: () => [{ id: "openrouter", name: "OpenRouter" }],
      getModels: () => [{ id: "openrouter-model", name: "OpenRouter model" }],
      hasConfiguredAuth: () => true,
      // ModelRuntime can report an env-backed API-key model even when the
      // account's auth.json has no credential for that provider.
      getAvailable: async () => [
        {
          provider: "openrouter",
          id: "openrouter-model",
          name: "OpenRouter model",
          input: ["text"],
          reasoning: false,
        },
      ],
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: {
        getProvider: (id: string) => ({ id }),
        getProviders: () => [{ id: "openrouter" }],
        getModels: () => [],
        hasConfiguredAuth: () => false,
      },
      modelCache: {
        at: Date.now(),
        value: [
          {
            value: "openrouter::openrouter-model",
            label: "OpenRouter model",
            providerID: "openrouter",
            modelID: "openrouter-model",
          },
        ],
      },
      modelInflight: null,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(
        async () => accountRuntime as never,
      ),
    };

    const account = createAccount({
      label: "未認証",
      providers: ["openrouter"],
    });

    const models = await listModelsForAccounts([account]);

    assert.deepEqual(models, []);
    assert.deepEqual(await listProviderModelsCatalog(), []);
  });

  it("does not report ambient API-key auth for an account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-account-auth-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    useTestAgentDir(dir);
    const account = createAccount({
      label: "未認証",
      providers: ["openrouter"],
    });
    const accountRuntime = {
      getProviders: () => [
        {
          id: "openrouter",
          name: "OpenRouter",
          auth: { apiKey: {}, oauth: undefined },
        },
      ],
      getProviderAuthStatus: () => ({
        configured: true,
        source: "environment",
        label: "OPENROUTER_API_KEY",
      }),
      isUsingSubscription: () => false,
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: {
        getProvider: (id: string) => ({ id }),
      },
      initPromise: null,
      watchdogRegistered: true,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(
        async () => accountRuntime as never,
      ),
    };

    const provider = (await listProviderAuth(account.id)).find(
      (item) => item.id === "openrouter",
    );

    assert.deepEqual(provider, {
      id: "openrouter",
      name: "OpenRouter",
      authenticated: false,
      methods: ["api_key"],
      authSource: undefined,
      authLabel: undefined,
      subscription: false,
      oauthAvailable: false,
      highlighted: false,
      accountRoutingMode: "separate",
    });
  });

  it("merges account models into one option in integrated mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-routing-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = useTestAgentDir(dir);
    const first = createAccount({
      label: "仕事用",
      providers: ["openai-codex"],
    });
    const second = createAccount({
      label: "個人用",
      providers: ["openai-codex"],
    });
    storeAccountProviderAuth(first, agentDir, "openai-codex");
    storeAccountProviderAuth(second, agentDir, "openai-codex");
    const makeRuntime = () => ({
      registerProvider: () => {},
      getProvider: () => undefined,
      getProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
      getModels: () => [{ id: "gpt-5", name: "GPT-5" }],
      getModel: (providerID: string, modelID: string) =>
        providerID === "openai-codex" && modelID === "gpt-5"
          ? {
              provider: providerID,
              id: modelID,
              input: ["text"],
              reasoning: false,
            }
          : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: async () => [
        {
          provider: "openai-codex",
          id: "gpt-5",
          name: "GPT-5",
          input: ["text"],
          reasoning: false,
        },
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
      accountRuntimes: new AccountRuntimeManager(
        async () => makeRuntime() as never,
      ),
    };
    await setAccountRoutingMode("openai-codex", "integrated");

    const models = await listModelsForAccounts([
      { id: first.id, label: first.label, providers: first.providers },
      { id: second.id, label: second.label, providers: second.providers },
    ]);
    const options = models.filter(
      (model) => model.providerID === "openai-codex",
    );
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

  it("excludes a limited provider from Auto routing after a limit response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-autolimit-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = useTestAgentDir(dir);
    const codexFirst = createAccount({
      label: "Codex 仕事用",
      providers: ["openai-codex"],
    });
    const codexSecond = createAccount({
      label: "Codex 個人用",
      providers: ["openai-codex"],
    });
    const claude = createAccount({
      label: "Claude 用",
      providers: ["anthropic"],
    });
    storeAccountProviderAuth(codexFirst, agentDir, "openai-codex");
    storeAccountProviderAuth(codexSecond, agentDir, "openai-codex");
    storeAccountProviderAuth(claude, agentDir, "anthropic");
    const makeRuntime = (providerID: string, modelID: string) => () => ({
      registerProvider: () => {},
      getProvider: () => undefined,
      getProviders: () => [{ id: providerID, name: modelID }],
      getModels: () => [{ id: modelID, name: modelID }],
      getModel: (provider: string, model: string) =>
        provider === providerID && model === modelID
          ? { provider, id: model, input: ["text"], reasoning: false }
          : undefined,
      hasConfiguredAuth: () => true,
      getAvailable: async () => [
        {
          provider: providerID,
          id: modelID,
          name: modelID,
          input: ["text"],
          reasoning: false,
        },
      ],
    });
    const runtimes = new Map([
      [codexFirst.id, makeRuntime("openai-codex", "gpt-5")],
      [codexSecond.id, makeRuntime("openai-codex", "gpt-5")],
      [claude.id, makeRuntime("anthropic", "claude-sonnet-5")],
    ]);
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      modelRuntime: {
        getProviders: () => [{ id: "openai-codex" }, { id: "anthropic" }],
        modelCache: null,
      },
      modelCache: { at: Date.now(), value: [] },
      modelInflight: null,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(
        async (accountId) => runtimes.get(accountId)!() as never,
      ),
    };
    await setAccountRoutingMode("openai-codex", "integrated");
    const accounts = [
      { id: codexFirst.id, label: codexFirst.label, providers: codexFirst.providers },
      { id: codexSecond.id, label: codexSecond.label, providers: codexSecond.providers },
      { id: claude.id, label: claude.label, providers: claude.providers },
    ];

    const before = await listModelsForAccounts(accounts);
    const beforeCodex = before.find((model) => model.providerID === "openai-codex");
    assert.equal(beforeCodex?.codexbarMaxed, false);

    // 429 応答後の一時除外は、モデル一覧と Auto の候補選択へ反映される。
    markProviderLimited("openai-codex", codexFirst.id);
    markProviderLimited("openai-codex", codexSecond.id);
    invalidateHealthCache();

    const models = await listModelsForAccounts(accounts);
    const codexOption = models.find((model) => model.providerID === "openai-codex");
    assert.equal(codexOption?.codexbarMaxed, true);
    assert.equal(codexOption?.codexbarUsedPercent, 100);

    const usage = autoProviderUsageFromModels(models);
    const decision = chooseAutoModel({
      models,
      tier: "light",
      hasImages: false,
      usage,
    });
    assert.equal(decision?.providerID, "anthropic");
    assert.equal(decision?.modelID, "claude-sonnet-5");
    assert.equal(decision?.accountId, claude.id);
  });

  it("orders integrated providers by the settings row order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-row-order-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const agentDir = useTestAgentDir(dir);
    const account = createAccount({
      label: "仕事用",
      providers: ["openai-codex"],
    });
    storeAccountProviderAuth(account, agentDir, "openai-codex");
    const accountRuntime = {
      registerProvider: () => {},
      getProvider: () => undefined,
      getProviders: () => [{ id: "openai-codex", name: "OpenAI Codex" }],
      getModels: () => [{ id: "gpt-5", name: "GPT-5" }],
      getModel: () => undefined,
      hasConfiguredAuth: () => true,
      getAvailable: async () => [
        {
          provider: "openai-codex",
          id: "gpt-5",
          name: "GPT-5",
          input: ["text"],
          reasoning: false,
        },
      ],
    };
    const harness: Record<string, unknown> = {
      modelRuntime: {
        getProviders: () => [{ id: "openai-codex" }, { id: "llama-server" }],
      },
      modelCache: null,
      modelInflight: null,
      live: new Map(),
      lastProviderSyncWarnings: [],
      accountRuntimes: new AccountRuntimeManager(
        async () => accountRuntime as never,
      ),
    };
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = harness;
    await setAccountRoutingMode("openai-codex", "integrated");
    // 設定画面は統合行をプロバイダキーで保存し、過去のアカウント別キーは末尾に残る。
    await saveProviderModelsOrder({
      providerOrder: [
        "openai-codex",
        "llama-server",
        `${account.id}::openai-codex`,
      ],
    });
    // 上の保存は modelCache を破棄するため、共有プロバイダはこの後に seed する。
    harness.modelCache = {
      at: Date.now(),
      value: [
        {
          value: "llama-server::local",
          label: "Local",
          providerID: "llama-server",
          modelID: "local",
        },
      ],
    };

    const models = await listModelsForAccounts([
      { id: account.id, label: account.label, providers: account.providers },
    ]);

    assert.deepEqual(
      models.map((model) => model.providerID),
      ["openai-codex", "llama-server"],
    );
  });

  it("saves enabled state and order in the account namespace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-models-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const account = createAccount({
      label: "仕事用",
      providers: ["openai-codex"],
    });

    await setProviderOrModelEnabled("openai-codex::gpt-5", false, account.id);
    await saveProviderModelsOrder({
      accountModelOrder: {
        [account.id]: { "openai-codex": ["gpt-4", "gpt-5"] },
      },
    });

    const state = readProviderModelState(providerModelStatePath(dir));
    assert.equal(state.disabled[`${account.id}::openai-codex::gpt-5`], true);
    assert.deepEqual(state.modelOrder[`${account.id}::openai-codex`], [
      "gpt-4",
      "gpt-5",
    ]);
    await assert.rejects(
      () => setProviderOrModelEnabled("anthropic", false, account.id),
      (error) => (error as { status?: number }).status === 400,
    );
    await assert.rejects(
      () => setProviderOrModelEnabled("openai-codex", false),
      (error) => (error as { status?: number }).status === 400,
    );
  });

  it("starts all child models disabled when enabling an account provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-provider-enable-"));
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const account = createAccount({
      label: "仕事用",
      providers: ["openai-codex"],
    });

    await setProviderOrModelEnabled(
      "openai-codex",
      true,
      account.id,
      ["gpt-5", "gpt-4"],
    );

    const state = readProviderModelState(providerModelStatePath(dir));
    assert.equal(state.disabled[`${account.id}::openai-codex`], undefined);
    assert.equal(state.disabled[`${account.id}::openai-codex::gpt-5`], true);
    assert.equal(state.disabled[`${account.id}::openai-codex::gpt-4`], true);
  });

  it("applies integrated model settings to every provider account", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "leafcode-pi-harness-integrated-models-"),
    );
    tempDirs.push(dir);
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const first = createAccount({
      label: "仕事用",
      providers: ["openai-codex"],
    });
    const second = createAccount({
      label: "個人用",
      providers: ["openai-codex"],
    });

    await setAccountRoutingMode("openai-codex", "integrated");
    await setProviderOrModelEnabled(
      "openai-codex",
      true,
      undefined,
      ["gpt-5", "gpt-4"],
    );
    await setProviderOrModelEnabled("openai-codex::gpt-5", false);
    await saveProviderModelsOrder({
      modelOrder: { "openai-codex": ["gpt-4", "gpt-5"] },
    });

    const state = readProviderModelState(providerModelStatePath(dir));
    assert.equal(state.disabled[`${first.id}::openai-codex::gpt-5`], true);
    assert.equal(state.disabled[`${second.id}::openai-codex::gpt-5`], true);
    assert.equal(state.disabled[`${first.id}::openai-codex::gpt-4`], true);
    assert.equal(state.disabled[`${second.id}::openai-codex::gpt-4`], true);
    assert.deepEqual(state.modelOrder[`${first.id}::openai-codex`], [
      "gpt-4",
      "gpt-5",
    ]);
    assert.deepEqual(state.modelOrder[`${second.id}::openai-codex`], [
      "gpt-4",
      "gpt-5",
    ]);
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
