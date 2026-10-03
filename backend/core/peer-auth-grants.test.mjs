import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPeerGrantStore, generatePeerToken, hashPeerToken } from "./peer-auth-grants.mjs";
import { parsePeerBearer } from "./peer-auth-wire.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "leafcode-peer-grants-"));
  const path = join(root, "peer-auth.json");
  return { root, path, store: createPeerGrantStore({ path }), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("generated tokens satisfy the wire bearer format and hash deterministically", () => {
  const token = generatePeerToken();
  assert.equal(parsePeerBearer(`Bearer ${token}`), token);
  assert.notEqual(token, generatePeerToken());
  assert.equal(hashPeerToken(token), hashPeerToken(token));
  assert.match(hashPeerToken(token), /^[0-9a-f]{64}$/);
});

test("the token is returned once and only its hash is persisted", async () => {
  const { path, store, cleanup } = await fixture();
  try {
    const { grant, token } = store.create({ label: " laptop ", providers: ["anthropic", "anthropic", "openai-codex"] });
    assert.equal(grant.label, "laptop");
    assert.deepEqual(grant.providers, ["anthropic", "openai-codex"]);
    assert.equal("tokenSha256" in grant, false);
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes(token), false);
    assert.equal(raw.includes(hashPeerToken(token)), true);
    assert.equal(JSON.stringify(store.list()).includes(hashPeerToken(token)), false);
  } finally { await cleanup(); }
});

test("verify requires sharing to be enabled, then matches only the issued token", async () => {
  const { store, cleanup } = await fixture();
  try {
    const first = store.create({ label: "a", providers: ["anthropic"] });
    const second = store.create({ label: "b", providers: ["openai-codex"] });
    assert.equal(store.isEnabled(), false);
    assert.equal(store.verify(first.token), null);
    store.setEnabled(true);
    assert.equal(store.verify(first.token)?.id, first.grant.id);
    assert.deepEqual(store.verify(second.token)?.providers, ["openai-codex"]);
    for (const bad of [generatePeerToken(), "", undefined, 5, "x".repeat(513), `${first.token}x`]) assert.equal(store.verify(bad), null);
    store.setEnabled(false);
    assert.equal(store.verify(first.token), null);
  } finally { await cleanup(); }
});

test("revoke removes a grant and its token stops verifying", async () => {
  const { store, cleanup } = await fixture();
  try {
    store.setEnabled(true);
    const { grant, token } = store.create({ label: "a", providers: ["anthropic"] });
    assert.equal(store.revoke("missing"), false);
    assert.equal(store.revoke(grant.id), true);
    assert.equal(store.verify(token), null);
    assert.deepEqual(store.list(), []);
  } finally { await cleanup(); }
});

test("invalid input is rejected with status 400 and nothing is written", async () => {
  const { root, store, cleanup } = await fixture();
  try {
    for (const input of [
      { label: "", providers: ["a"] }, { label: "x".repeat(101), providers: ["a"] }, { label: "l", providers: [] },
      { label: "l", providers: ["bad id"] }, { label: "l", providers: "a" },
    ]) assert.throws(() => store.create(input), (error) => error.status === 400);
    assert.throws(() => store.setEnabled("yes"), (error) => error.status === 400);
    assert.deepEqual(await readdir(root), []);
  } finally { await cleanup(); }
});

test("grant count is capped", async () => {
  const { store, cleanup } = await fixture();
  try {
    for (let i = 0; i < 20; i += 1) store.create({ label: `g${i}`, providers: ["a"] });
    assert.throws(() => store.create({ label: "over", providers: ["a"] }), (error) => error.status === 400);
  } finally { await cleanup(); }
});

test("a corrupt file fails closed and malformed entries never verify", async () => {
  const { path, store, cleanup } = await fixture();
  try {
    await writeFile(path, "{not json", "utf8");
    assert.equal(store.isEnabled(), false);
    assert.deepEqual(store.list(), []);
    const token = generatePeerToken();
    await writeFile(path, JSON.stringify({ version: 1, enabled: true, grants: [
      { id: "1", label: "ok", tokenSha256: hashPeerToken(token), accountId: null, providers: ["a"], createdAt: "t" },
      { id: "2", label: "bad", tokenSha256: "short", accountId: null, providers: ["a"], createdAt: "t" },
    ] }), "utf8");
    assert.equal(store.verify(token)?.id, "1");
    assert.equal(store.list().length, 1);
  } finally { await cleanup(); }
});

test("writes leave no temp files behind", async () => {
  const { root, store, cleanup } = await fixture();
  try {
    store.create({ label: "a", providers: ["a"] });
    store.setEnabled(true);
    assert.deepEqual(await readdir(root), ["peer-auth.json"]);
  } finally { await cleanup(); }
});

test("updates refuse to overwrite a corrupt store and leave no lock behind", async () => {
  const { root, path, store, cleanup } = await fixture();
  try {
    await writeFile(path, "{not json", "utf8");
    assert.throws(() => store.create({ label: "x", providers: ["a"] }), /corrupted/);
    assert.throws(() => store.setEnabled(true), /corrupted/);
    assert.equal(await readFile(path, "utf8"), "{not json");
    assert.equal((await readdir(root)).some((name) => name.endsWith(".lock")), false);
  } finally { await cleanup(); }
});
