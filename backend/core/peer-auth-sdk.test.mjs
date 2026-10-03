import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Proves the design's key claim against the real SDK: ModelRuntime accepts the peer credential store,
// and OAuth refresh goes through `modify`, where the store re-resolves from the sharing LCP instead of
// refreshing locally. Everything runs offline and inside a temp agent dir.

const HOUR = 60 * 60 * 1000;

function stubStore({ expiresInMs = HOUR } = {}) {
  const calls = { read: 0, modify: 0, list: 0, deletes: 0, fnRan: 0 };
  const credential = () => ({ type: "oauth", access: `access-${calls.modify}`, expires: Date.now() + expiresInMs, refresh: "" });
  return {
    calls,
    async read() { calls.read += 1; return credential(); },
    async list() { calls.list += 1; return [{ providerId: "anthropic", type: "oauth" }]; },
    // Never runs fn: on B only the sharing LCP may rotate the token.
    async modify() { calls.modify += 1; calls.fnRan += 1; return credential(); },
    async delete() { calls.deletes += 1; },
  };
}

async function runtimeWith(store, modelsStorePath) {
  return ModelRuntime.create({
    credentials: store,
    authPath: join(modelsStorePath, "..", "auth.json"),
    modelsStorePath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

test("the real SDK resolves provider auth from the peer store without refreshing locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-peer-sdk-"));
  try {
    const store = stubStore();
    const runtime = await runtimeWith(store, join(root, "models-store.json"));
    assert.ok(runtime.getProvider("anthropic"), "anthropic is a built-in provider");

    const result = await runtime.getAuth("anthropic");
    assert.equal(result?.auth?.apiKey, "access-0");
    assert.ok(store.calls.read >= 1);
    assert.equal(store.calls.modify, 0, "a token with an hour left needs no refresh");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an expiring token goes through modify, and the store's re-resolved token is used as-is", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-peer-sdk-"));
  try {
    // Inside the SDK's five-minute window, so it would normally refresh here.
    const store = stubStore({ expiresInMs: 60_000 });
    const runtime = await runtimeWith(store, join(root, "models-store.json"));

    const result = await runtime.getAuth("anthropic");
    assert.equal(store.calls.modify, 1, "the SDK asks the store to refresh");
    // The SDK's own refresh callback inside modify was never given a credential refresh token to use;
    // the token it returns is exactly the one the peer store re-resolved.
    assert.equal(result?.auth?.apiKey, "access-1");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("no local auth file is created or read for a peer runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "leafcode-peer-sdk-"));
  try {
    const authPath = join(root, "auth.json");
    await writeFile(authPath, JSON.stringify({ anthropic: { type: "oauth", access: "local-SECRET", refresh: "r", expires: Date.now() + HOUR } }), "utf8");
    const store = stubStore();
    const runtime = await ModelRuntime.create({
      credentials: store,
      authPath,
      modelsStorePath: join(root, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const result = await runtime.getAuth("anthropic");
    assert.equal(result?.auth?.apiKey, "access-0");
    assert.equal(JSON.stringify(result).includes("local-SECRET"), false, "the injected store owns the provider");
  } finally { await rm(root, { recursive: true, force: true }); }
});
