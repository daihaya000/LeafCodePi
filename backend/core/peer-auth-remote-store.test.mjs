import assert from "node:assert/strict";
import test from "node:test";
import { createPeerCacheRegistry, createRemotePeerCredentialStore } from "./peer-auth-remote-store.mjs";

const TOKEN = "T".repeat(43);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const oauth = (expires, access = "acc") => ({ credential: { type: "oauth", access, expires, refresh: "LEAK" } });
const LIST_PATH = "/api/peer-auth/list";

function setup({ responses = [], accountId, offered = ["anthropic", "openrouter", "x"], listBody, registry = createPeerCacheRegistry() } = {}) {
  let time = 1_000_000;
  const calls = [];
  const queue = [...responses];
  const state = { listFails: false };
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith(LIST_PATH)) {
      if (state.listFails) throw new Error("ECONNREFUSED");
      // The metadata list is always served unless a test overrides it; offers are per account.
      return (listBody ?? json(200, {
        providers: offered.map((providerId) => ({ providerId, type: "oauth" })),
        accounts: [{ accountId: accountId ?? null, label: "a", providers: offered }],
      })).clone();
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next.clone();
  };
  const make = (overrides = {}) => createRemotePeerCredentialStore({
    peerUrl: "http://a.test:3000/some/path", token: TOKEN, accountId, now: () => time, fetch, registry, ...overrides,
  });
  const store = make();
  return {
    store, make, state, calls, advance: (ms) => { time += ms; }, now: () => time,
    resolves: () => calls.filter((call) => call.init?.method === "POST"),
    lists: () => calls.filter((call) => call.init?.method === "GET"),
  };
}

test("read resolves from A with the bearer token, never follows redirects, and strips refresh", async () => {
  const f = setup({ responses: [json(200, oauth(1_000_000 + 3_600_000))] });
  const credential = await f.store.read("anthropic");
  assert.deepEqual(credential, { type: "oauth", access: "acc", expires: f.now() + 3_600_000, refresh: "" });
  assert.equal(f.lists().length, 1);
  const [resolve] = f.resolves();
  assert.equal(resolve.url, "http://a.test:3000/api/peer-auth/resolve");
  assert.equal(resolve.init.redirect, "error");
  assert.equal(resolve.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(resolve.init.body), { providerId: "anthropic" });
});

test("accountId is sent only when set", async () => {
  const f = setup({ accountId: "acc1", responses: [json(200, { credential: { type: "api_key", key: "k" } })] });
  await f.store.read("openrouter");
  assert.deepEqual(JSON.parse(f.resolves()[0].init.body), { providerId: "openrouter", accountId: "acc1" });
});

test("stores for the same peer share one list and one credential cache across instances", async () => {
  const registry = createPeerCacheRegistry();
  const f = setup({ registry, responses: [json(200, { credential: { type: "api_key", key: "k" } })] });
  assert.equal((await f.store.read("openrouter")).key, "k");
  // A recreated runtime gets a new store instance but must not hit A again.
  assert.equal((await f.make().read("openrouter")).key, "k");
  assert.equal(f.lists().length, 1);
  assert.equal(f.resolves().length, 1);
});

test("offers are per account: a provider only another account of A holds is absent", async () => {
  const f = setup({ accountId: "acc1", listBody: json(200, {
    providers: [{ providerId: "anthropic", type: "oauth" }, { providerId: "openai-codex", type: "oauth" }],
    accounts: [
      { accountId: "acc1", label: "one", providers: ["openai-codex"] },
      { accountId: "acc2", label: "two", providers: ["anthropic"] },
    ],
  }) });
  assert.equal(await f.store.read("anthropic"), undefined);
  // An account A no longer shares (for example its default account) is offered nothing.
  assert.equal(await f.make({ accountId: null }).read("openai-codex"), undefined);
  assert.equal(f.resolves().length, 0);
});

test("a stale list still decides offers while A is briefly unreachable", async () => {
  const f = setup({ responses: [json(200, { credential: { type: "api_key", key: "k1" } }), json(200, { credential: { type: "api_key", key: "k2" } })] });
  assert.equal((await f.store.read("openrouter")).key, "k1");
  f.state.listFails = true;
  f.advance(6 * 60_000); // list and API key cache both expired
  assert.equal((await f.store.read("openrouter")).key, "k2");
  assert.equal(await f.store.read("not-offered"), undefined);
});

test("a provider the peer does not offer is absent without a resolve request", async () => {
  const f = setup({ offered: ["anthropic"], responses: [json(200, oauth(1_000_000 + 3_600_000))] });
  assert.equal(await f.store.read("not-offered"), undefined);
  assert.equal(f.resolves().length, 0);
  assert.equal(f.lists().length, 1);
});

test("a token with more than the margin left is served from cache; near expiry it is re-resolved", async () => {
  const f = setup({ responses: [
    json(200, oauth(1_000_000 + 3_600_000, "first")), json(200, oauth(1_000_000 + 7_200_000, "second")),
  ] });
  assert.equal((await f.store.read("anthropic")).access, "first");
  f.advance(10 * 60_000);
  assert.equal((await f.store.read("anthropic")).access, "first");
  assert.equal(f.resolves().length, 1);
  f.advance(3_600_000 - 10 * 60_000 - 5 * 60_000); // 5 min left: below the 6 min margin
  assert.equal((await f.store.read("anthropic")).access, "second");
  assert.equal(f.resolves().length, 2);
  assert.ok((await f.store.read("anthropic")).expires > f.now());
});

test("when A is unreachable an unexpired cached token is still served; an expired one fails", async () => {
  const f = setup({ responses: [json(200, oauth(1_000_000 + 3_600_000)), new Error("ECONNREFUSED")] });
  await f.store.read("anthropic");
  f.advance(3_600_000 - 5 * 60_000);
  assert.equal((await f.store.read("anthropic")).access, "acc");
  f.advance(5 * 60_000 + 1);
  await assert.rejects(f.store.read("anthropic"), /Peer auth request failed/);
});

test("modify never runs fn and forces a fresh resolve", async () => {
  const f = setup({ responses: [json(200, oauth(1_000_000 + 3_600_000, "a")), json(200, oauth(1_000_000 + 3_600_000, "b"))] });
  await f.store.read("anthropic");
  let ran = false;
  const result = await f.store.modify("anthropic", async () => { ran = true; return undefined; });
  assert.equal(ran, false);
  assert.equal(result.access, "b");
  assert.equal(f.resolves().length, 2);
});

test("404 means no credential; 401/403/5xx/invalid bodies fail with a generic error and no leakage", async () => {
  assert.equal(await setup({ responses: [json(404, { error: "not-found" })] }).store.read("anthropic"), undefined);
  for (const response of [json(401, { error: "unauthorized" }), json(403, { error: "forbidden" }), json(503, { error: "unavailable" }),
    json(200, { credential: { type: "oauth", access: "", expires: 1 } }), new Response("not json", { status: 200 })]) {
    await assert.rejects(setup({ responses: [response] }).store.read("anthropic"), (error) => {
      assert.match(error.message, /^Peer auth request failed/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    });
  }
});

test("a revoked grant (401) clears the cache instead of serving a stale token", async () => {
  const f = setup({ responses: [json(200, oauth(1_000_000 + 3_600_000)), json(401, { error: "unauthorized" })] });
  await f.store.read("anthropic");
  f.advance(3_600_000 - 5 * 60_000);
  await assert.rejects(f.store.read("anthropic"), /\(401\)/);
  await assert.rejects(f.store.read("anthropic"), /\(401\)/);
});

test("concurrent reads share one list and one resolve request", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = setup({ responses: [async () => { await gate; return json(200, oauth(1_000_000 + 3_600_000)); }] });
  const pending = [f.store.read("anthropic"), f.store.read("anthropic"), f.store.read("anthropic")];
  release();
  const results = await Promise.all(pending);
  assert.equal(f.resolves().length, 1);
  assert.equal(f.lists().length, 1);
  assert.equal(new Set(results.map((credential) => credential.access)).size, 1);
});

test("API keys are cached for the TTL, then re-resolved", async () => {
  const f = setup({ responses: [json(200, { credential: { type: "api_key", key: "k1" } }), json(200, { credential: { type: "api_key", key: "k2" } })] });
  assert.equal((await f.store.read("openrouter")).key, "k1");
  f.advance(4 * 60_000);
  assert.equal((await f.store.read("openrouter")).key, "k1");
  f.advance(2 * 60_000);
  assert.equal((await f.store.read("openrouter")).key, "k2");
  assert.equal(f.resolves().length, 2);
});

test("list returns provider metadata only and is briefly cached; delete is a no-op", async () => {
  const f = setup({ listBody: json(200, { providers: [{ providerId: "anthropic", type: "oauth", secret: "x" }], accounts: [
    { accountId: null, label: "既定", providers: ["anthropic"] },
  ] }) });
  assert.deepEqual(await f.store.list(), [{ providerId: "anthropic", type: "oauth" }]);
  assert.deepEqual(await f.store.listAccounts(), [{ accountId: null, label: "既定", providers: ["anthropic"] }]);
  await f.store.list();
  assert.equal(f.lists().length, 1);
  f.advance(31_000);
  await f.store.list();
  assert.equal(f.lists().length, 2);
  assert.equal(await f.store.delete("anthropic"), undefined);
  assert.equal(f.lists().length, 2);
});

test("constructor rejects unsafe peer URLs and missing tokens", () => {
  for (const peerUrl of ["ftp://a.test", "http://user:pw@a.test", "not a url", "http://a.test/#x"]) {
    assert.throws(() => createRemotePeerCredentialStore({ peerUrl, token: TOKEN }));
  }
  assert.throws(() => createRemotePeerCredentialStore({ peerUrl: "http://a.test", token: "" }), /token/);
});
