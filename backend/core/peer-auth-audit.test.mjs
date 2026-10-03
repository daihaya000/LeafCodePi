import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPeerAuditLog, createPeerRateLimiter } from "./peer-auth-audit.mjs";

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-peer-audit-"));
  const path = join(root, "peer-auth-audit.jsonl");
  return { root, path, log: createPeerAuditLog({ path, now: () => new Date("2026-10-03T00:00:00Z"), ...options }), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("records identifiers and outcomes only", async () => {
  const { path, log, cleanup } = await fixture();
  try {
    assert.equal(log.record({ peerId: "p1", action: "resolve", providerId: "anthropic", accountId: null, result: "ok", token: "SECRET", credential: "SECRET" }), true);
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("SECRET"), false);
    assert.deepEqual(log.read(), [{ at: "2026-10-03T00:00:00.000Z", peerId: "p1", action: "resolve", providerId: "anthropic", accountId: null, result: "ok" }]);
  } finally { await cleanup(); }
});

test("rejects unknown actions and results, and neutralises unsafe identifiers", async () => {
  const { log, cleanup } = await fixture();
  try {
    assert.equal(log.record({ action: "other", result: "ok" }), false);
    assert.equal(log.record({ action: "list", result: "weird" }), false);
    log.record({ peerId: "bad id\n{\"x\":1}", providerId: "../x", action: "denied", result: "unauthorized" });
    assert.deepEqual(log.read().map(({ peerId, providerId }) => [peerId, providerId]), [[null, null]]);
  } finally { await cleanup(); }
});

test("keeps only the newest maxLines entries", async () => {
  const { root, log, cleanup } = await fixture({ maxLines: 5 });
  try {
    for (let i = 0; i < 12; i += 1) log.record({ peerId: `p${i}`, action: "list", result: "ok" });
    assert.deepEqual(log.read(100).map((entry) => entry.peerId), ["p7", "p8", "p9", "p10", "p11"]);
    assert.deepEqual(await readdir(root), ["peer-auth-audit.jsonl"]);
  } finally { await cleanup(); }
});

test("a new log instance continues the existing line count", async () => {
  const { path, cleanup } = await fixture();
  try {
    const first = createPeerAuditLog({ path, maxLines: 3 });
    for (let i = 0; i < 3; i += 1) first.record({ peerId: `a${i}`, action: "list", result: "ok" });
    const second = createPeerAuditLog({ path, maxLines: 3 });
    second.record({ peerId: "b", action: "list", result: "ok" });
    assert.deepEqual(second.read().map((entry) => entry.peerId), ["a1", "a2", "b"]);
  } finally { await cleanup(); }
});

test("record never throws when the log cannot be written", () => {
  const log = createPeerAuditLog({ path: join(tmpdir(), "leafcode-missing\0bad", "x.jsonl") });
  assert.equal(log.record({ action: "list", result: "ok" }), false);
  assert.deepEqual(log.read(), []);
});

test("rate limiter allows the limit per window per key, then recovers", () => {
  let time = 1000;
  const limiter = createPeerRateLimiter({ limit: 2, windowMs: 1000, now: () => time });
  assert.equal(limiter.take("a").ok, true);
  assert.equal(limiter.take("a").ok, true);
  const blocked = limiter.take("a");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterMs, 1000);
  assert.equal(limiter.take("b").ok, true);
  time += 400;
  assert.equal(limiter.take("a").retryAfterMs, 600);
  time += 600;
  assert.equal(limiter.take("a").ok, true);
});

test("rate limiter refuses new keys at capacity instead of growing without bound", () => {
  let time = 0;
  const limiter = createPeerRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 2, now: () => time });
  assert.equal(limiter.take("a").ok, true);
  assert.equal(limiter.take("b").ok, true);
  assert.equal(limiter.take("c").ok, false);
  assert.equal(limiter.take("a").ok, true);
  time = 1000;
  assert.equal(limiter.take("c").ok, true);
});
