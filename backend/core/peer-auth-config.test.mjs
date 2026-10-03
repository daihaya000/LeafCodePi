import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizePeerUrl, parsePeerConfig, peerConfigPath, readPeerConfig, removePeerConfig, writePeerConfig } from "./peer-auth-config.mjs";

const TOKEN = "k".repeat(43);
const valid = { peerUrl: "http://100.64.0.2:3000", peerAccountId: null, providers: ["anthropic"], token: TOKEN };

async function dir() {
  const root = await mkdtemp(join(tmpdir(), "leafcode-peer-config-"));
  return { root, accountDir: join(root, "accounts", "acc1"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("peer URLs are reduced to a plain http(s) origin", () => {
  assert.equal(normalizePeerUrl("http://a.test:3000"), "http://a.test:3000");
  assert.equal(normalizePeerUrl(" https://a.test/ "), "https://a.test");
  assert.equal(normalizePeerUrl("http://a.test/path"), "http://a.test");
  for (const bad of ["ftp://a.test", "http://u:p@a.test", "http://a.test/#x", "http://a.test/?q=1", "nope", 5, null]) {
    assert.equal(normalizePeerUrl(bad), null);
  }
});

test("write then read round-trips a normalized config and leaves no temp files", async () => {
  const { accountDir, cleanup } = await dir();
  try {
    const written = writePeerConfig(accountDir, { ...valid, peerUrl: "http://100.64.0.2:3000/x", providers: ["anthropic", "anthropic", "openai-codex"] }, () => new Date("2026-10-03T00:00:00Z"));
    assert.equal(written.peerUrl, "http://100.64.0.2:3000");
    assert.deepEqual(written.providers, ["anthropic", "openai-codex"]);
    assert.equal(written.createdAt, "2026-10-03T00:00:00.000Z");
    assert.deepEqual(readPeerConfig(accountDir), written);
    assert.deepEqual(await readdir(accountDir), ["peer.json"]);
    if (process.platform !== "win32") assert.equal((await stat(peerConfigPath(accountDir))).mode & 0o777, 0o600);
  } finally { await cleanup(); }
});

test("invalid configs are rejected on write (400) and read as null on disk", async () => {
  const { accountDir, cleanup } = await dir();
  try {
    for (const bad of [
      { ...valid, token: "short" }, { ...valid, token: `${TOKEN}!` }, { ...valid, peerUrl: "ftp://x" }, { ...valid, providers: [] },
      { ...valid, providers: ["bad id"] }, { ...valid, peerAccountId: "../x" }, { ...valid, createdAt: "not a date" },
    ]) assert.throws(() => writePeerConfig(accountDir, bad), (error) => error.status === 400);
    // Validation happens before any directory or file is created.
    assert.deepEqual(await readdir(join(accountDir, "..")).catch(() => []), []);
    await mkdir(accountDir, { recursive: true });
    await writeFile(peerConfigPath(accountDir), "{broken", "utf8");
    assert.equal(readPeerConfig(accountDir), null);
  } finally { await cleanup(); }
});

test("a missing file or a wrong version is not a peer account", async () => {
  const { accountDir, cleanup } = await dir();
  try {
    assert.equal(readPeerConfig(accountDir), null);
    assert.equal(parsePeerConfig({ ...valid, version: 2, createdAt: "2026-10-03T00:00:00Z" }), null);
    assert.equal(parsePeerConfig(null), null);
    assert.equal(parsePeerConfig([]), null);
  } finally { await cleanup(); }
});

test("the token is stored only in peer.json and removal deletes the marker", async () => {
  const { accountDir, cleanup } = await dir();
  try {
    writePeerConfig(accountDir, { ...valid, peerAccountId: "acc9" });
    assert.equal((await readFile(peerConfigPath(accountDir), "utf8")).includes(TOKEN), true);
    assert.equal(readPeerConfig(accountDir).peerAccountId, "acc9");
    removePeerConfig(accountDir);
    removePeerConfig(accountDir);
    assert.equal(readPeerConfig(accountDir), null);
  } finally { await cleanup(); }
});
