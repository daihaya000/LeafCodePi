import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrateMcpConfigFile } from "./mcp-config-migration-file.mjs";

const legacy = { mcpServers: { server: { command: "fixture-server", disabled: true, env: { KEY: "!read-key" } } } };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, bytes = JSON.stringify(legacy)) {
  const root = await fs.mkdtemp(join(tmpdir(), "leafcode-mcp-file-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = join(root, "mcp.json");
  await fs.writeFile(configPath, bytes);
  return { root, configPath };
}

test("dry-run leaves source bytes and directory untouched and hides config values", async (t) => {
  const source = JSON.stringify({ mcpServers: { server: { url: "https://example.invalid/mcp",
    disabled: true, headers: { Authorization: "private-fixture-token" } } } });
  const { root, configPath } = await fixture(t, source);
  const result = await migrateMcpConfigFile({ configPath });
  assert.deepEqual(result, { ok: true, issues: [], applied: false, changed: true,
    sourceSha256: hash(source), serverCount: 1 });
  assert.equal(JSON.stringify(result).includes("private-fixture-token"), false);
  assert.equal(await fs.readFile(configPath, "utf8"), source);
  assert.deepEqual(await fs.readdir(root), ["mcp.json"]);
});

test("apply saves byte-exact BOM/CRLF backup, round-trips Japanese and removes transient files", async (t) => {
  const input = structuredClone(legacy);
  input.mcpServers.server.args = ["日本語", "emoji-😀"];
  const source = "\uFEFF" + JSON.stringify(input, null, "\t").replace(/\n/g, "\r\n") + "\r\n";
  const { root, configPath } = await fixture(t, source);
  const dryRun = await migrateMcpConfigFile({ configPath });
  const result = await migrateMcpConfigFile({ configPath, apply: true, expectedSha256: dryRun.sourceSha256 });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(await fs.readFile(result.backupPath, "utf8"), source);
  const output = await fs.readFile(configPath);
  assert.equal(result.resultSha256, hash(output));
  const text = output.toString("utf8");
  assert.equal(text.startsWith("\uFEFF"), true);
  assert.equal(text.endsWith("\r\n"), true);
  assert.equal(/(?<!\r)\n/.test(text), false);
  assert.equal(text.includes("\r\n\t\"mcpServers\""), true);
  const normalized = JSON.parse(text.slice(1));
  assert.deepEqual(normalized.mcpServers.server.args, ["日本語", "emoji-😀"]);
  assert.equal(normalized.mcpServers.server.enabled, false);
  assert.equal(Object.hasOwn(normalized.mcpServers.server, "disabled"), false);
  assert.deepEqual((await fs.readdir(root)).sort(), ["mcp.json", result.backupPath.slice(root.length + 1)].sort());
});

test("apply requires a dry-run hash and refuses a stale one without any writes", async (t) => {
  const { root, configPath } = await fixture(t);
  assert.equal((await migrateMcpConfigFile({ configPath, apply: true })).issues[0].code, "source-hash-required");
  const dry = await migrateMcpConfigFile({ configPath });
  const concurrent = JSON.stringify({ mcpServers: { other: { command: "changed" } } });
  await fs.writeFile(configPath, concurrent);
  const result = await migrateMcpConfigFile({ configPath, apply: true, expectedSha256: dry.sourceSha256 });
  assert.equal(result.issues[0].code, "source-changed");
  assert.equal(await fs.readFile(configPath, "utf8"), concurrent);
  assert.deepEqual(await fs.readdir(root), ["mcp.json"]);
});

test("invalid encoding, JSON and SDK settings cannot create backups or overwrite input", async (t) => {
  const { root, configPath } = await fixture(t);
  for (const [source, code] of [[Buffer.from([0xff]), "invalid-source-encoding"],
    [Buffer.from("{ private-fixture-token"), "invalid-source-json"],
    [Buffer.from(JSON.stringify({ mcpServers: { server: { url: "${MISSING}", disabled: true } } })), "unresolved-url-variable"],
    [Buffer.from(JSON.stringify({ mcpServers: { server: { command: "server", timeout: -1 } } })), "sdk-invalid-server"]]) {
    await fs.writeFile(configPath, source);
    const result = await migrateMcpConfigFile({ configPath, apply: true, expectedSha256: hash(source) });
    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, code);
    assert.equal(JSON.stringify(result).includes("private-fixture-token"), false);
    assert.deepEqual(await fs.readFile(configPath), source);
    assert.deepEqual(await fs.readdir(root), ["mcp.json"]);
  }
});

test("existing migration lock is preserved rather than stolen or removed", async (t) => {
  const { root, configPath } = await fixture(t);
  const source = await fs.readFile(configPath);
  await fs.writeFile(`${configPath}.migration.lock`, "other-writer");
  const result = await migrateMcpConfigFile({ configPath, apply: true, expectedSha256: hash(source) });
  assert.equal(result.issues[0].code, "migration-lock-unavailable");
  assert.equal(await fs.readFile(`${configPath}.migration.lock`, "utf8"), "other-writer");
  assert.deepEqual(await fs.readFile(configPath), source);
  assert.equal((await fs.readdir(root)).length, 2);
});

test("already-native input is a byte-preserving no-op, including apply", async (t) => {
  const source = '{ "mcpServers": { "server": { "command": "fixture-server", "enabled": false } } }';
  const { root, configPath } = await fixture(t, source);
  const result = await migrateMcpConfigFile({ configPath, apply: true, expectedSha256: hash(source) });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.applied, false);
  assert.equal(await fs.readFile(configPath, "utf8"), source);
  assert.deepEqual(await fs.readdir(root), ["mcp.json"]);
});

test("concurrent migration attempts cannot both apply or create two backups", async (t) => {
  const { root, configPath } = await fixture(t);
  const expectedSha256 = hash(await fs.readFile(configPath));
  const results = await Promise.all([1, 2].map(() => migrateMcpConfigFile({ configPath, apply: true, expectedSha256 })));
  assert.equal(results.filter((result) => result.applied).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.equal((await fs.readdir(root)).filter((name) => name.endsWith(".bak")).length, 1);
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")), false);
});

test("rename failure retains source and backup, removes temp/lock, and sanitizes errors", async (t) => {
  const { root, configPath } = await fixture(t);
  const source = await fs.readFile(configPath);
  t.mock.method(fs, "rename", async () => { throw new Error("private-fixture-token"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await migrateMcpConfigFile({ configPath, apply: true, expectedSha256: hash(source) });
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.issues[0].code, "migration-write-failed");
  assert.equal(JSON.stringify(result).includes("private-fixture-token"), false);
  assert.deepEqual(await fs.readFile(configPath), source);
  assert.deepEqual(await fs.readFile(result.backupPath), source);
  assert.equal((await fs.readdir(root)).length, 2);
});

test("rechecks the source after validation AND immediately before rename", async (t) => {
  const { root, configPath } = await fixture(t);
  const originalRead = fs.readFile;
  const concurrent = JSON.stringify({ mcpServers: { other: { command: "changed" } } });
  for (const changeOnRead of [2, 3]) {
    const source = JSON.stringify(legacy);
    await fs.writeFile(configPath, source);
    let reads = 0;
    t.mock.method(fs, "readFile", async (path, ...args) => {
      if (path === configPath && ++reads === changeOnRead) await fs.writeFile(configPath, concurrent);
      return originalRead(path, ...args);
    });
    syncBuiltinESMExports();
    let result;
    try {
      result = await migrateMcpConfigFile({ configPath, apply: true, expectedSha256: hash(source) });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(result.issues[0].code, "source-changed");
    assert.equal(result.applied, false);
    assert.equal(await fs.readFile(configPath, "utf8"), concurrent);
    if (changeOnRead === 3) assert.equal(await fs.readFile(result.backupPath, "utf8"), source);
    assert.equal((await fs.readdir(root)).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")), false);
  }
});

test("invalid options and non-regular or missing sources fail closed", async (t) => {
  const { root } = await fixture(t);
  assert.equal((await migrateMcpConfigFile()).issues[0].code, "invalid-file-options");
  assert.equal((await migrateMcpConfigFile({ configPath: root })).issues[0].code, "source-not-regular-file");
  assert.equal((await migrateMcpConfigFile({ configPath: join(root, "missing.json") })).issues[0].code, "source-unreadable");
  assert.equal((await migrateMcpConfigFile({ configPath: root, apply: "true" })).issues[0].code, "invalid-file-options");
});
