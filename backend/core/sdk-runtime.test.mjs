import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SdkRuntimeFactory } from "./sdk-runtime.mjs";
import { AccountRuntimeManager } from "./account-runtime-manager.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("SDK imports are lazy and coalesced across concurrent consumers", async () => {
  const gate = deferred();
  let calls = 0;
  const factory = new SdkRuntimeFactory({ loadSdk: () => { calls++; return gate.promise; } });
  assert.equal(calls, 0);
  const first = factory.load();
  const second = factory.load();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  const sdk = {};
  gate.resolve(sdk);
  assert.equal(await first, sdk);
  assert.equal(await factory.load(), sdk);
  assert.equal(calls, 1);
});

test("failed SDK loads, including synchronous failures, can be retried", async () => {
  let calls = 0;
  const sdk = {};
  const factory = new SdkRuntimeFactory({ loadSdk: () => {
    calls++;
    if (calls === 1) throw new Error("import failed");
    return Promise.resolve(sdk);
  } });
  await assert.rejects(factory.load(), /import failed/);
  assert.equal(await factory.load(), sdk);
  assert.equal(calls, 2);
});

test("runtime creation forwards scoped options and waits for provider registration", async () => {
  const options = { authPath: "account-auth", modelsStorePath: "account-models", allowModelNetwork: false };
  const runtime = {};
  const gate = deferred();
  const sequence = [];
  const factory = new SdkRuntimeFactory({ loadSdk: async () => ({ ModelRuntime: { create: async (received) => {
    assert.equal(received, options);
    sequence.push("created");
    return runtime;
  } } }) });
  const creation = factory.createModelRuntime(options, async (received) => {
    assert.equal(received, runtime);
    sequence.push("registering");
    await gate.promise;
    sequence.push("registered");
  });
  let done = false;
  void creation.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sequence, ["created", "registering"]);
  assert.equal(done, false);
  gate.resolve();
  assert.equal(await creation, runtime);
  assert.deepEqual(sequence, ["created", "registering", "registered"]);
});

test("runtime and registration failures are not reported as successful initialization", async () => {
  const factory = new SdkRuntimeFactory({ loadSdk: async () => ({ ModelRuntime: { create: async () => ({}) } }) });
  await assert.rejects(factory.createModelRuntime({}, async () => { throw new Error("provider failed"); }), /provider failed/);
  const failed = new SdkRuntimeFactory({ loadSdk: async () => ({ ModelRuntime: { create: async () => { throw new Error("runtime failed"); } } }) });
  await assert.rejects(failed.createModelRuntime({}), /runtime failed/);
});

test("session creation preserves all overrides and leaves ownership to the caller", async () => {
  const options = { cwd: "workspace", tools: [], sessionManager: {}, resourceLoader: {} };
  const result = { session: {} };
  const factory = new SdkRuntimeFactory({ loadSdk: async () => ({ createAgentSession: async (received) => {
    assert.equal(received, options);
    return result;
  } }) });
  assert.equal(await factory.createAgentSession(options), result);
});

test("account runtime creation is isolated, coalesced and retryable", async () => {
  const gate = deferred();
  let calls = 0;
  const manager = new AccountRuntimeManager(async (id) => {
    calls++;
    if (id === "retry" && calls === 1) throw new Error("failed");
    return gate.promise;
  });
  await assert.rejects(manager.ensure("retry"), /failed/);
  const first = manager.acquire("retry");
  const second = manager.acquire("retry");
  const runtime = {};
  gate.resolve(runtime);
  assert.equal(await first, runtime);
  assert.equal(await second, runtime);
  assert.equal(calls, 2);
  manager.release("retry");
  manager.evictIdle();
  assert.equal(manager.peek("retry"), runtime);
});

test("referenced accounts survive idle eviction and recent accounts win the LRU", async () => {
  const manager = new AccountRuntimeManager(async (id) => ({ id }));
  const held = await manager.acquire("held");
  for (const id of ["one", "two"]) {
    await manager.acquire(id);
    manager.release(id);
  }
  await manager.ensure("one");
  await manager.ensure("three");
  manager.evictIdle();
  assert.equal(manager.peek("held"), held);
  assert.equal(manager.peek("two"), undefined);
  assert.ok(manager.peek("one"));
  assert.ok(manager.peek("three"));
});

test("real Pi SDK initializes an offline runtime using only explicit temporary storage", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "leafcode-pi-backend-sdk-"));
  try {
    const factory = new SdkRuntimeFactory();
    const sdk = await factory.load();
    assert.equal(typeof sdk.createAgentSession, "function");
    const runtime = await factory.createModelRuntime({
      authPath: join(directory, "auth.json"),
      modelsPath: join(directory, "models.json"),
      modelsStorePath: join(directory, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    assert.equal(typeof runtime.getProviders, "function");
    assert.ok(Array.isArray(runtime.getProviders()));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
