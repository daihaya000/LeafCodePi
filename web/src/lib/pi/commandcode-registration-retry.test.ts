import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ importExtension: vi.fn() }));
vi.mock("jiti/static", () => ({ createJiti: () => ({ import: mocks.importExtension }) }));

import { __resetCommandCodeProviderCacheForTests, registerCommandCodeProvider } from "./commandcode-provider";
import { __resetPiAgentDirCacheForTests, accountAuthPath, createAccount } from "@/lib/accounts";
import { AccountRuntimeManager } from "./account-runtime-manager";
import { getRuntimeFor } from "./harness";

const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];

function recoveredFactory(api: { registerProvider: (id: string, config: unknown) => void }) {
  api.registerProvider("commandcode", {
    baseUrl: "https://commandcode.test/v1", api: "openai-completions", apiKey: "test-key",
    models: [{ id: "recovered", name: "Recovered", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 64 }],
  });
}

afterEach(() => {
  __resetCommandCodeProviderCacheForTests();
  mocks.importExtension.mockReset();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).__leafcodePiHarness;
  if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  __resetPiAgentDirCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("retries a transient extension import failure without repeating imports during backoff", async () => {
  __resetCommandCodeProviderCacheForTests();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.importExtension.mockRejectedValueOnce(new Error("Temporary extension load failure"));
  mocks.importExtension.mockResolvedValue(recoveredFactory);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  await registerCommandCodeProvider(runtime);
  assert.equal(runtime.getProvider("commandcode"), undefined);
  await registerCommandCodeProvider(runtime);
  assert.equal(mocks.importExtension.mock.calls.length, 1);
  clock.mockReturnValue(7_000);
  await registerCommandCodeProvider(runtime);
  assert.equal(runtime.getModels("commandcode")[0]?.id, "recovered");
  assert.equal(mocks.importExtension.mock.calls.length, 2);
  await registerCommandCodeProvider(runtime);
  assert.equal(mocks.importExtension.mock.calls.length, 2, "successful registrations remain cached");
});

it("recovers a cached account runtime on reuse without recreating it or changing account auth", async () => {
  __resetCommandCodeProviderCacheForTests();
  const root = mkdtempSync(join(tmpdir(), "commandcode-account-retry-"));
  roots.push(root);
  process.env.LEAFCODE_PI_DATA_DIR = root;
  const agentDir = process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  __resetPiAgentDirCacheForTests();
  const account = createAccount({ label: "Retry Account", providers: ["commandcode"] });
  const authPath = accountAuthPath(account.id, agentDir);
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.importExtension.mockRejectedValueOnce(new Error("Temporary extension load failure"));
  mocks.importExtension.mockResolvedValue(recoveredFactory);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("commandcode", async () => ({ type: "api_key", key: "account-test-key" }));
  const runtime = await ModelRuntime.create({ credentials,
    modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  let creations = 0;
  const manager = new AccountRuntimeManager(async () => {
    creations += 1;
    await registerCommandCodeProvider(runtime, { key: `account:${account.id}`, kind: "account",
      accountId: account.id, accountLabel: account.label, authPath });
    return runtime;
  });
  const state = { accountRuntimes: manager, live: new Map(), healthCache: { at: 0 },
    modelCache: { at: 0 }, accountModelCache: { at: 0 } };
  (globalThis as Record<string, unknown>).__leafcodePiHarness = state;
  assert.equal(await getRuntimeFor(account.id), runtime);
  assert.equal(runtime.getProvider("commandcode"), undefined);
  assert.equal(await getRuntimeFor(account.id), runtime);
  assert.equal(mocks.importExtension.mock.calls.length, 1);
  assert.notEqual(state.modelCache, null, "backoff must not invalidate the model cache");
  clock.mockReturnValue(7_000);
  assert.equal(await getRuntimeFor(account.id), runtime);
  assert.equal(runtime.getModels("commandcode")[0]?.id, "recovered");
  assert.equal((await runtime.getAuth("commandcode"))?.auth.apiKey, "account-test-key");
  assert.equal(state.modelCache, null, "recovery must discard stale model snapshots");
  assert.equal(creations, 1);
  assert.equal(await getRuntimeFor(account.id), runtime);
  assert.equal(mocks.importExtension.mock.calls.length, 2);
  assert.equal(existsSync(authPath), false, "account auth files must remain untouched");
});
