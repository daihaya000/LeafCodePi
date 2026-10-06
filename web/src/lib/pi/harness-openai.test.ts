import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { accountAuthPath, createAccount, __resetPiAgentDirCacheForTests } from "@/lib/accounts";
import { autoProviderUsageFromModels, chooseAutoModel } from "@/lib/auto-model";
import { clearCachedUsage } from "@/lib/codexbar/cache";
import { __resetProviderRoutingQueueForTests, markProviderLimited } from "@/lib/provider-routing";
import { insertTask, setTaskStatus } from "@/lib/store";
import { acquireTaskLease, releaseTaskLease } from "@/lib/task-runtime-lease";
import { AccountRuntimeManager } from "./account-runtime-manager";
import {
  invalidateHealthCache,
  listModelsForAccounts,
  listProviderAuth,
  listProviderModelsCatalog,
  resolveProviderFallbackModels,
  setProviderAccountRoutingMode,
  setProviderOrModelEnabled,
} from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";
const MODEL_ID = "gpt-6.1-sol";
const dirs: string[] = [];
const leasedTasks: string[] = [];
const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-openai-"));
  dirs.push(dir);
  process.env.LEAFCODE_PI_DATA_DIR = dir;
  const agentDir = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  __resetPiAgentDirCacheForTests();
  clearCachedUsage();
  const runtimes = new Map<string, ReturnType<typeof makeRuntime>>();
  const addAccount = (provider: "openai" | "openai-codex", subscription = true) => {
    const account = createAccount({ label: `${provider}-${runtimes.size}`, providers: [provider] });
    const path = accountAuthPath(account.id, agentDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ [provider]: subscription
      ? { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 1,
          ...(provider === "openai" ? { clientId: "test-client", scopes: ["chatgpt.tokens.use.direct"] } : {}) }
      : { type: "api_key", key: "test-key" } }), "utf8");
    runtimes.set(account.id, makeRuntime(provider, subscription));
    return account;
  };
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    modelRuntime: makeRuntime("openai", false),
    accountRuntimes: new AccountRuntimeManager(async (id) => runtimes.get(id) as never),
    // A default API credential must not leak into account-scoped model rows.
    modelCache: { at: Date.now(), value: [{ value: `openai::${MODEL_ID}`, label: "Default API", providerID: "openai", modelID: MODEL_ID }] },
    modelInflight: null,
    live: new Map(),
    watchdogRegistered: true,
    lastProviderSyncWarnings: [],
  };
  return { addAccount };
}

function makeRuntime(provider: string, subscription: boolean) {
  const model = { provider, id: MODEL_ID, name: "GPT-6.1 Sol", input: ["text"], reasoning: false };
  return {
    getProvider: (id: string) => ({ id }),
    getProviders: () => [{ id: provider, name: provider === "openai-codex" ? "OpenAI Codex (legacy)" : provider, auth: { apiKey: {}, oauth: {} } }],
    getModels: () => [model],
    getModel: (id: string, modelId: string) => id === provider && modelId === MODEL_ID ? model : undefined,
    registerProvider: () => undefined,
    hasConfiguredAuth: () => true,
    isUsingSubscription: () => subscription,
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    getAvailable: async () => [model],
  };
}

afterEach(() => {
  for (const id of leasedTasks.splice(0)) releaseTaskLease(id);
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  clearCachedUsage();
  __resetProviderRoutingQueueForTests();
  __resetPiAgentDirCacheForTests();
  if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("new OpenAI account integration", () => {
  it.each([true, false])("exposes OpenAI auth and keeps subscription status accurate: %s", async (subscription) => {
    const { addAccount } = setup();
    const account = addAccount("openai", subscription);
    const auth = (await listProviderAuth(account.id)).find((item) => item.id === "openai");
    assert.equal(auth?.highlighted, true);
    assert.equal(auth?.authenticated, true);
    assert.equal(auth?.subscription, subscription);
    assert.equal(auth?.accountRoutingMode, "separate");
    assert.deepEqual(auth?.methods, ["api_key", "oauth"]);
    const models = await listModelsForAccounts([account]);
    assert.equal(models.length, 1);
    assert.equal(models[0].value, `${account.id}::openai::${MODEL_ID}`);
    assert.equal(models[0].subscription, subscription);
    await assert.rejects(() => setProviderAccountRoutingMode("openai", "integrated"), /2つ以上/);
  });

  it("merges only OpenAI accounts and excludes exhausted routes from Auto", async () => {
    const { addAccount } = setup();
    const first = addAccount("openai");
    const second = addAccount("openai");
    const legacy = addAccount("openai-codex");
    const accounts = [first, second, legacy];
    await setProviderAccountRoutingMode("openai", "integrated");
    let models = await listModelsForAccounts(accounts);
    const modern = models.find((item) => item.providerID === "openai");
    assert.equal(modern?.value, `openai::${MODEL_ID}`);
    assert.equal(modern?.routingCandidateCount, 2);
    assert.equal(modern?.codexbarUsedPercent, null);
    assert.equal(models.find((item) => item.providerID === "openai-codex")?.accountId, legacy.id);
    const catalog = await listProviderModelsCatalog();
    assert.deepEqual(catalog.find((row) => row.id === "openai")?.accountIds, [first.id, second.id]);
    assert.equal(catalog.find((row) => row.id === "openai-codex")?.accountId, legacy.id);
    assert.equal(catalog.find((row) => row.id === "openai-codex")?.name, "OpenAI Codex");
    const legacyAuth = (await listProviderAuth(legacy.id)).find((item) => item.id === "openai-codex");
    assert.equal(legacyAuth?.name, "OpenAI Codex");
    assert.equal(legacyAuth?.oauthAvailable, true);

    markProviderLimited("openai", first.id);
    markProviderLimited("openai", second.id);
    invalidateHealthCache();
    models = await listModelsForAccounts(accounts);
    assert.equal(models.find((item) => item.providerID === "openai")?.codexbarMaxed, true);
    assert.equal(models.find((item) => item.providerID === "openai")?.codexbarUnavailable, true);
    const choice = chooseAutoModel({ models, tier: "light", hasImages: false, usage: autoProviderUsageFromModels(models) });
    assert.equal(choice?.providerID, "openai-codex");

    await setProviderOrModelEnabled(`openai::${MODEL_ID}`, false);
    models = await listModelsForAccounts(accounts);
    assert.equal(models.some((item) => item.providerID === "openai"), false);
    assert.equal(models.some((item) => item.providerID === "openai-codex"), true);
  });

  it("keeps a mixed OAuth/API pool available when only the subscription is limited", async () => {
    const { addAccount } = setup();
    const subscription = addAccount("openai");
    const api = addAccount("openai", false);
    await setProviderAccountRoutingMode("openai", "integrated");
    markProviderLimited("openai", subscription.id);
    const models = await listModelsForAccounts([subscription, api]);
    assert.equal(models.length, 1);
    assert.equal(models[0].subscription, false);
    assert.equal(models[0].codexbarMaxed, false);
    assert.equal(models[0].codexbarUnavailable, false);
    assert.equal(models[0].routingCandidateCount, 2);
    const routes = await resolveProviderFallbackModels({ providerID: "openai", modelID: MODEL_ID, accountId: subscription.id });
    assert.deepEqual(routes, [{ providerID: "openai", modelID: MODEL_ID, accountId: api.id }]);
  });

  it("balances unknown usage by task count and falls back within OpenAI before legacy", async () => {
    const { addAccount } = setup();
    const first = addAccount("openai");
    const second = addAccount("openai");
    const legacy = addAccount("openai-codex");
    const task = insertTask({ project: null, title: "busy", providerID: "openai", modelID: MODEL_ID, accountId: first.id });
    assert.equal(acquireTaskLease(task.id), true);
    leasedTasks.push(task.id);
    setTaskStatus(task.id, "working");
    await setProviderAccountRoutingMode("openai", "integrated");

    const fromLegacy = await resolveProviderFallbackModels({ providerID: "openai-codex", modelID: MODEL_ID, accountId: legacy.id });
    assert.deepEqual(fromLegacy, [{ providerID: "openai", modelID: MODEL_ID, accountId: second.id }]);
    markProviderLimited("openai", first.id);
    const fromModern = await resolveProviderFallbackModels({ providerID: "openai", modelID: MODEL_ID, accountId: first.id });
    assert.deepEqual(fromModern, [
      { providerID: "openai", modelID: MODEL_ID, accountId: second.id },
      { providerID: "openai-codex", modelID: MODEL_ID, accountId: legacy.id },
    ]);
    markProviderLimited("openai", second.id);
    const allModernLimited = await resolveProviderFallbackModels({ providerID: "openai", modelID: MODEL_ID, accountId: first.id });
    assert.deepEqual(allModernLimited, [{ providerID: "openai-codex", modelID: MODEL_ID, accountId: legacy.id }]);
  });
});
