import assert from "node:assert/strict";
import { test } from "node:test";
import { SOUL_TEMPLATE } from "./bot-config.mjs";
import { createBotWithEffects, deleteBotWithEffects, patchBotWithEffects } from "./bot-lifecycle.mjs";

const ID = "0f0f0f0f-aaaa-bbbb-cccc-000000000001";
const NOW = "2026-09-30T00:00:00.000Z";
const DEFAULT_TOOLS = ["read", "intercom"];

function fixture(overrides = {}) {
  const events = [];
  const configs = new Map();
  const tasks = [];
  let uuidCounter = 0;
  const deps = {
    store: {
      workspacePath: (id) => { events.push(`workspacePath:${id}`); return `/bots/${id}/workspace`; },
      writeSoul: (id, text) => events.push(`writeSoul:${id}:${text.length}`),
      ensureMemoryFile: (id) => events.push(`ensureMemory:${id}`),
      writeConfig: (config) => { events.push(`writeConfig:${config.id}`); configs.set(config.id, config); },
      readConfig: (id) => { events.push(`readConfig:${id}`); return configs.get(id) ?? null; },
      removeBot: (id) => events.push(`removeBot:${id}`),
    },
    tasks: {
      insertBotTask: (input) => { events.push(`insertTask:${input.id}`); tasks.push(input); },
      patchTask: (id, patch) => { events.push(`patchTask:${id}:${JSON.stringify(patch)}`); },
      deleteTask: (id) => { events.push(`deleteTask:${id}`); },
      listTasks: () => { events.push("listTasks"); return overrides.taskRows ?? []; },
    },
    defaultToolNames: DEFAULT_TOOLS,
    soulTemplate: SOUL_TEMPLATE,
    ensureWorkspace: (directory) => events.push(`mkdir:${directory}`),
    toDto: (config) => ({ ...config, soul: "soul text" }),
    uuid: () => { uuidCounter += 1; return uuidCounter === 1 ? ID : `0f0f0f0f-aaaa-bbbb-cccc-00000000000${uuidCounter}`; },
    now: () => NOW,
    ...overrides,
  };
  return { events, configs, tasks, deps };
}

test("creating a bot writes workspace, SOUL, MEMORY and config in that order, then registers the 1:1 task", () => {
  const f = fixture();
  const dto = createBotWithEffects({ name: "  作業用  " }, f.deps);
  assert.deepEqual(f.events, [
    `workspacePath:${ID}`,
    `mkdir:/bots/${ID}/workspace`,
    `writeSoul:${ID}:${SOUL_TEMPLATE.length}`,
    `ensureMemory:${ID}`,
    `writeConfig:${ID}`,
    `insertTask:bot:${ID}`,
  ]);
  assert.deepEqual(f.tasks, [{
    id: `bot:${ID}`, botId: ID, name: "作業用", directory: `/bots/${ID}/workspace`,
    model: null, thinkingLevel: null, permissionMode: "allow",
  }]);
  assert.equal(dto.id, ID);
  assert.equal(dto.soul, "soul text");
  assert.deepEqual(dto.tools, DEFAULT_TOOLS);
});

test("the created config carries the requested model, thinking level and permission", () => {
  const f = fixture();
  createBotWithEffects({ name: "Bot", model: "openai-codex::gpt-5", thinkingLevel: "high", permissionMode: "ask" }, f.deps);
  const stored = f.configs.get(ID);
  assert.equal(stored.model, "openai-codex::gpt-5");
  assert.equal(stored.thinkingLevel, "high");
  assert.equal(stored.permissionMode, "ask");
  assert.equal(f.tasks[0].model, "openai-codex::gpt-5");
  assert.equal(f.tasks[0].thinkingLevel, "high");
  assert.equal(f.tasks[0].permissionMode, "ask");
});

test("patching writes the config first, the SOUL only when the patch carries one, then the task fields", () => {
  const f = fixture();
  createBotWithEffects({ name: "Bot" }, f.deps);
  f.events.length = 0;
  const dto = patchBotWithEffects(ID, { name: "After", thinkingLevel: "max" }, f.deps);
  assert.deepEqual(f.events, [
    `readConfig:${ID}`,
    `writeConfig:${ID}`,
    `patchTask:bot:${ID}:{"title":"After","thinkingLevel":"max","permissionMode":"allow"}`,
  ]);
  assert.equal(dto.name, "After");
  assert.equal(f.configs.get(ID).name, "After");
});

test("a patched SOUL is written after the config and never stored in it", () => {
  const f = fixture();
  createBotWithEffects({ name: "Bot" }, f.deps);
  f.events.length = 0;
  const dto = patchBotWithEffects(ID, { soul: "# new" }, f.deps);
  assert.deepEqual(f.events, [
    `readConfig:${ID}`,
    `writeConfig:${ID}`,
    `writeSoul:${ID}:5`,
    // A null thinking level is passed as undefined, so the task patch omits the key entirely.
    `patchTask:bot:${ID}:{"title":"Bot","permissionMode":"allow"}`,
  ]);
  assert.equal("soul" in f.configs.get(ID), false);
  assert.equal(dto.soul, "soul text");
});

test("patching an unknown bot reads once and changes nothing", () => {
  const f = fixture();
  assert.equal(patchBotWithEffects(ID, { name: "x" }, f.deps), undefined);
  assert.deepEqual(f.events, [`readConfig:${ID}`]);
});

test("deleting removes owned tasks, un-supervises the rest, then deletes the directory", () => {
  const f = fixture({
    taskRows: [
      { id: "t-own", botId: ID },
      { id: "t-supervised", supervisorBotId: ID },
      { id: "t-other", botId: "someone-else" },
      { id: "t-both", botId: ID, supervisorBotId: ID },
    ],
  });
  createBotWithEffects({ name: "Bot" }, f.deps);
  f.events.length = 0;
  assert.equal(deleteBotWithEffects(ID, f.deps), true);
  assert.deepEqual(f.events, [
    `readConfig:${ID}`,
    "listTasks",
    "deleteTask:t-own",
    `patchTask:t-supervised:{"supervisorBotId":null}`,
    "deleteTask:t-both",
    `removeBot:${ID}`,
  ]);
});

test("deleting an unknown bot reads once and reports false without touching tasks", () => {
  const f = fixture();
  assert.equal(deleteBotWithEffects(ID, f.deps), false);
  assert.deepEqual(f.events, [`readConfig:${ID}`]);
});

test("delete stops before the directory when a task operation throws", () => {
  const f = fixture({ taskRows: [{ id: "t-own", botId: ID }] });
  createBotWithEffects({ name: "Bot" }, f.deps);
  f.deps.tasks.deleteTask = () => { f.events.push("deleteTask:threw"); throw new Error("task store down"); };
  f.events.length = 0;
  assert.throws(() => deleteBotWithEffects(ID, f.deps), /task store down/);
  assert.deepEqual(f.events, [`readConfig:${ID}`, "listTasks", "deleteTask:threw"]);
});

test("a failing task registration leaves the bot files in place for the caller to report", () => {
  const f = fixture();
  f.deps.tasks.insertBotTask = () => { f.events.push("insertTask:threw"); throw new Error("task store down"); };
  assert.throws(() => createBotWithEffects({ name: "Bot" }, f.deps), /task store down/);
  assert.deepEqual(f.events.at(-1), "insertTask:threw");
  assert.equal(f.configs.get(ID).name, "Bot", "the config was already written");
});
