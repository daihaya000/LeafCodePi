import assert from "node:assert/strict";
import test from "node:test";
import { createRemotePeerCredentialStore } from "./peer-auth-remote-store.mjs";

const TOKEN = "T".repeat(43);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const oauth = (expires, access = "acc") => ({ credential: { type: "oauth", access, expires, refresh: "LEAK" } });

function setup({ responses, accountId } = {}) {
  let time = 1_000_000;
  const calls = [];
  const queue = [...responses];
  const store = createRemotePeerCredentialStore({
    peerUrl: "http://a.test:3000/some/path", token: TOKEN, accountId, now: () => time,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next.clone();
    },
  });
  return { store, calls, advance: (ms) => { time += ms; }, now: () => time };
}

test("read resolves from A with the bearer token, never follows redirects, and strips refresh", async () => {
  const { store, calls, now } = setup({ responses: [json(200, oauth(1_000_000 + 3_600_000))] });
  const credential = await store.read("anthropic");
  assert.deepEqual(credential, { type: "oauth", access: "acc", expires: now() + 3_600_000, refresh: "" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://a.test:3000/api/peer-auth/resolve");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { providerId: "anthropic" });
});

test("accountId is sent only when set", async () => {
  const { store, calls } = setup({ accountId: "acc1", responses: [json(200, { credential: { type: "api_key", key: "k" } })] });
  await store.read("openrouter");
  assert.deepEqual(JSON.parse(calls[0].init.body), { providerId: "openrouter", accountId: "acc1" });
});

test("a token with more than the margin left is served from cache; near expiry it is re-resolved", async () => {
  const { store, calls, advance, now } = setup({ responses: [
    json(200, oauth(1_000_000 + 3_600_000, "first")), json(200, oauth(1_000_000 + 7_200_000, "second")),
  ] });
  assert.equal((await store.read("anthropic")).access, "first");
  advance(10 * 60_000);
  assert.equal((await store.read("anthropic")).access, "first");
  assert.equal(calls.length, 1);
  advance(3_600_000 - 10 * 60_000 - 5 * 60_000); // 5 min left: below the 6 min margin
  assert.equal((await store.read("anthropic")).access, "second");
  assert.equal(calls.length, 2);
  assert.ok((await store.read("anthropic")).expires > now());
});

test("when A is unreachable an unexpired cached token is still served; an expired one fails", async () => {
  const { store, advance } = setup({ responses: [json(200, oauth(1_000_000 + 3_600_000)), new Error("ECONNREFUSED")] });
  await store.read("anthropic");
  advance(3_600_000 - 5 * 60_000);
  assert.equal((await store.read("anthropic")).access, "acc");
  advance(5 * 60_000 + 1);
  await assert.rejects(store.read("anthropic"), /Peer auth request failed/);
});

test("modify never runs fn and forces a fresh resolve", async () => {
  const { store, calls } = setup({ responses: [json(200, oauth(1_000_000 + 3_600_000, "a")), json(200, oauth(1_000_000 + 3_600_000, "b"))] });
  await store.read("anthropic");
  let ran = false;
  const result = await store.modify("anthropic", async () => { ran = true; return undefined; });
  assert.equal(ran, false);
  assert.equal(result.access, "b");
  assert.equal(calls.length, 2);
});

test("404 means no credential; 401/403/5xx/invalid bodies fail with a generic error and no leakage", async () => {
  assert.equal(await setup({ responses: [json(404, { error: "not-found" })] }).store.read("x"), undefined);
  for (const response of [json(401, { error: "unauthorized" }), json(403, { error: "forbidden" }), json(503, { error: "unavailable" }),
    json(200, { credential: { type: "oauth", access: "", expires: 1 } }), new Response("not json", { status: 200 })]) {
    await assert.rejects(setup({ responses: [response] }).store.read("x"), (error) => {
      assert.match(error.message, /^Peer auth request failed/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    });
  }
});

test("a revoked grant (401) clears the cache instead of serving a stale token", async () => {
  const { store, advance } = setup({ responses: [json(200, oauth(1_000_000 + 3_600_000)), json(401, { error: "unauthorized" })] });
  await store.read("anthropic");
  advance(3_600_000 - 5 * 60_000);
  await assert.rejects(store.read("anthropic"), /\(401\)/);
  await assert.rejects(store.read("anthropic"), /\(401\)/);
});

test("concurrent reads share one request", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, calls } = setup({ responses: [async () => { await gate; return json(200, oauth(1_000_000 + 3_600_000)); }] });
  const pending = [store.read("anthropic"), store.read("anthropic"), store.read("anthropic")];
  release();
  const results = await Promise.all(pending);
  assert.equal(calls.length, 1);
  assert.equal(new Set(results.map((credential) => credential.access)).size, 1);
});

test("API keys are cached for the TTL, then re-resolved", async () => {
  const { store, calls, advance } = setup({ responses: [json(200, { credential: { type: "api_key", key: "k1" } }), json(200, { credential: { type: "api_key", key: "k2" } })] });
  assert.equal((await store.read("openrouter")).key, "k1");
  advance(4 * 60_000);
  assert.equal((await store.read("openrouter")).key, "k1");
  advance(2 * 60_000);
  assert.equal((await store.read("openrouter")).key, "k2");
  assert.equal(calls.length, 2);
});

test("list returns provider metadata only and is briefly cached; delete is a no-op", async () => {
  const { store, calls, advance } = setup({ responses: [json(200, { providers: [{ providerId: "anthropic", type: "oauth", secret: "x" }], accounts: [] })] });
  assert.deepEqual(await store.list(), [{ providerId: "anthropic", type: "oauth" }]);
  await store.list();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  advance(31_000);
  await store.list();
  assert.equal(calls.length, 2);
  assert.equal(await store.delete("anthropic"), undefined);
  assert.equal(calls.length, 2);
});

test("constructor rejects unsafe peer URLs and missing tokens", () => {
  for (const peerUrl of ["ftp://a.test", "http://user:pw@a.test", "not a url", "http://a.test/#x"]) {
    assert.throws(() => createRemotePeerCredentialStore({ peerUrl, token: TOKEN }));
  }
  assert.throws(() => createRemotePeerCredentialStore({ peerUrl: "http://a.test", token: "" }), /token/);
});
