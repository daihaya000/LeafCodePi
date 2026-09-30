import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SOUL_TEMPLATE } from "./bot-config.mjs";
import { BotFileStore } from "./bot-store.mjs";

const TOOL_NAMES = ["read", "write", "intercom"];
const DEFAULT_TOOL_NAMES = ["read", "intercom"];
const ID = "0f0f0f0f-aaaa-bbbb-cccc-000000000001";
const OTHER = "0f0f0f0f-aaaa-bbbb-cccc-000000000002";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "leafcode-bot-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const botsRoot = join(root, "bots");
  const store = new BotFileStore({ botsRoot: () => botsRoot, toolNames: TOOL_NAMES, defaultToolNames: DEFAULT_TOOL_NAMES });
  return { root, botsRoot, store };
}

const config = (id, overrides = {}) => ({
  id, name: "Bot", label: "", avatarColor: "#3B82F6", avatarImage: null, avatarShape: "circle",
  avatarGlasses: false, avatarMustache: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  model: null, ttsVoice: null, thinkingLevel: null, permissionMode: "allow", skills: { mode: "inherit", include: [], exclude: [] },
  tools: ["read"], extraRoots: [], enabled: true, notificationsEnabled: true, intercomEnabled: false,
  intercomScopeId: "", intercomFanoutEnabled: false, codeAutoApprove: true, codeSessionTaskId: null, ...overrides,
});

test("paths stay inside the bots root and reject anything but a UUID-shaped id", (t) => {
  const { store, botsRoot } = fixture(t);
  assert.equal(store.botRoot(ID), join(botsRoot, ID));
  assert.equal(store.configPath(ID), join(botsRoot, ID, "config.json"));
  assert.equal(store.soulPath(ID), join(botsRoot, ID, "SOUL.md"));
  assert.equal(store.memoryPath(ID), join(botsRoot, ID, "MEMORY.md"));
  assert.equal(store.workspacePath(ID), join(botsRoot, ID, "workspace"));
  for (const path of ["botRoot", "configPath", "soulPath", "memoryPath", "workspacePath"]) {
    assert.throws(() => store[path]("../../evil"), /invalid bot id/, path);
    assert.throws(() => store[path]("not-a-uuid"), /invalid bot id/, path);
  }
});

test("listing an empty or non-existent root yields no bots and creates nothing", (t) => {
  const { store, botsRoot } = fixture(t);
  assert.deepEqual(store.listConfigs(), []);
  assert.equal(store.readConfig(ID), null);
  assert.equal(store.soulRevision(ID), null);
  assert.equal(existsSync(botsRoot), false);
});

test("a written config is pretty-printed JSON with a trailing newline and reads back normalized", (t) => {
  const { store } = fixture(t);
  // A deliberate allowlist (writing is enabled) is not a historical default, so it is kept as stored.
  const stored = config(ID, { tools: ["read", "write"] });
  store.writeConfig(stored);
  assert.equal(readFileSync(store.configPath(ID), "utf8"), `${JSON.stringify(stored, null, 2)}\n`);
  assert.deepEqual(store.readConfig(ID), stored);
  assert.deepEqual(readdirSync(store.botRoot(ID)), ["config.json"]);
});

test("writing creates the bot directory and replaces an existing config", (t) => {
  const { store } = fixture(t);
  assert.equal(existsSync(store.botRoot(ID)), false);
  store.writeConfig(config(ID, { name: "First" }));
  store.writeConfig(config(ID, { name: "Second", tools: ["read", "write"] }));
  assert.equal(store.readConfig(ID).name, "Second");
  assert.deepEqual(store.readConfig(ID).tools, ["read", "write"]);
  assert.deepEqual(readdirSync(store.botRoot(ID)), ["config.json"], "no temporary file survives a successful write");
});

test("reading is refused for a corrupt, foreign-id or directory-instead-of-file config", (t) => {
  const { store } = fixture(t);
  mkdirSync(store.botRoot(ID), { recursive: true });
  writeFileSync(store.configPath(ID), "{not json");
  assert.equal(store.readConfig(ID), null);
  writeFileSync(store.configPath(ID), JSON.stringify(config(OTHER)));
  assert.equal(store.readConfig(ID), null);
  store.writeConfig(config(OTHER));
  assert.equal(store.readConfig(OTHER).id, OTHER);
  assert.equal(store.readConfig("not-a-uuid"), null);
});

test("listing returns valid bots newest first, skipping directories without a config", (t) => {
  const { store, botsRoot } = fixture(t);
  store.writeConfig(config(ID, { updatedAt: "2026-01-01T00:00:00.000Z" }));
  store.writeConfig(config(OTHER, { updatedAt: "2026-03-01T00:00:00.000Z" }));
  const third = "0f0f0f0f-aaaa-bbbb-cccc-000000000003";
  store.writeConfig(config(third, { updatedAt: "2026-02-01T00:00:00.000Z" }));
  mkdirSync(join(botsRoot, "0f0f0f0f-aaaa-bbbb-cccc-000000000004"), { recursive: true });
  writeFileSync(join(botsRoot, "loose.txt"), "x");
  assert.deepEqual(store.listConfigs().map((entry) => entry.id), [OTHER, third, ID]);
});

test("SOUL text is read and written verbatim, and its revision tracks mtime and size", (t) => {
  const { store } = fixture(t);
  assert.equal(store.soulRevision(ID), null);
  mkdirSync(store.botRoot(ID), { recursive: true });
  store.writeSoul(ID, SOUL_TEMPLATE);
  assert.equal(store.readSoulText(ID), SOUL_TEMPLATE);
  const first = store.soulRevision(ID);
  assert.equal(first, `${statSync(store.soulPath(ID)).mtimeMs}:${statSync(store.soulPath(ID)).size}`);
  store.writeSoul(ID, `${SOUL_TEMPLATE}\n追加`);
  assert.notEqual(store.soulRevision(ID), first);
  const stamp = new Date(Date.now() - 60_000);
  utimesSync(store.soulPath(ID), stamp, stamp);
  assert.equal(store.soulRevision(ID), `${statSync(store.soulPath(ID)).mtimeMs}:${statSync(store.soulPath(ID)).size}`);
  rmSync(store.soulPath(ID));
  assert.equal(store.soulRevision(ID), null);
});

test("MEMORY.md is created once and never overwritten", (t) => {
  const { store } = fixture(t);
  mkdirSync(store.botRoot(ID), { recursive: true });
  store.ensureMemoryFile(ID);
  assert.equal(readFileSync(store.memoryPath(ID), "utf8"), "# Bot memory\n\n");
  writeFileSync(store.memoryPath(ID), "# Bot memory\n\n- 学び\n");
  store.ensureMemoryFile(ID);
  assert.equal(readFileSync(store.memoryPath(ID), "utf8"), "# Bot memory\n\n- 学び\n");
});

test("removing a bot deletes the whole directory including workspace and memory", (t) => {
  const { store } = fixture(t);
  store.writeConfig(config(ID));
  store.writeSoul(ID, SOUL_TEMPLATE);
  store.ensureMemoryFile(ID);
  mkdirSync(store.workspacePath(ID), { recursive: true });
  writeFileSync(join(store.workspacePath(ID), "note.md"), "x");
  store.removeBot(ID);
  assert.equal(existsSync(store.botRoot(ID)), false);
  assert.equal(store.readConfig(ID), null);
  // Removing a bot that is not there is not an error.
  store.removeBot(ID);
  assert.throws(() => store.removeBot("../evil"), /invalid bot id/);
});

test("the root is resolved per call, so a moved data directory is followed", (t) => {
  const first = mkdtempSync(join(tmpdir(), "leafcode-bot-store-a-"));
  const second = mkdtempSync(join(tmpdir(), "leafcode-bot-store-b-"));
  t.after(() => { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); });
  let current = join(first, "bots");
  const store = new BotFileStore({ botsRoot: () => current, toolNames: TOOL_NAMES, defaultToolNames: DEFAULT_TOOL_NAMES });
  store.writeConfig(config(ID));
  current = join(second, "bots");
  assert.equal(store.readConfig(ID), null);
  store.writeConfig(config(OTHER));
  current = join(first, "bots");
  assert.equal(store.readConfig(ID).id, ID);
  assert.equal(store.readConfig(OTHER), null);
});
