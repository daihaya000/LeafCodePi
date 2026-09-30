import assert from "node:assert/strict";
import { test } from "node:test";
import { botPromptSources } from "./bot-prompt-sources.mjs";

const ID = "0f0f0f0f-aaaa-bbbb-cccc-000000000001";

function fixture({ existing = [], overrides = {} } = {}) {
  const calls = [];
  const present = new Set(existing);
  const paths = {
    sharedBotsMdPath: () => "/agent/BOTS.md",
    globalUserMdPath: () => "/agent/USER.md",
    soulPath: (id) => `/bots/${id}/SOUL.md`,
    memoryPath: (id) => `/bots/${id}/MEMORY.md`,
  };
  const deps = {
    ensureMemoryFile: (id) => { calls.push(`ensureMemory:${id}`); },
    sharedBotsMdPath: () => { calls.push("sharedPath"); return paths.sharedBotsMdPath(); },
    globalUserMdPath: () => { calls.push("userPath"); return paths.globalUserMdPath(); },
    soulPath: (id) => { calls.push(`soulPath:${id}`); return paths.soulPath(id); },
    memoryPath: (id) => { calls.push(`memoryPath:${id}`); return paths.memoryPath(id); },
    exists: (path) => { calls.push(`exists:${path}`); return present.has(path); },
  };
  return { calls, present, deps: { ...deps, ...overrides } };
}

test("every source exists: shared, user, SOUL, MEMORY in reading order", () => {
  const f = fixture({ existing: ["/agent/BOTS.md", "/agent/USER.md", `/bots/${ID}/MEMORY.md`] });
  assert.deepEqual(botPromptSources(ID, f.deps), [
    "/agent/BOTS.md", "/agent/USER.md", `/bots/${ID}/SOUL.md`, `/bots/${ID}/MEMORY.md`,
  ]);
});

test("MEMORY is initialized first and skipped as a source when it is still absent", () => {
  const f = fixture();
  assert.deepEqual(botPromptSources(ID, f.deps), [`/bots/${ID}/SOUL.md`]);
  assert.equal(f.calls[0], `ensureMemory:${ID}`, "MEMORY is created before any path is resolved");
  assert.deepEqual(f.calls.slice(1), [
    "sharedPath", "exists:/agent/BOTS.md",
    "userPath", "exists:/agent/USER.md",
    `soulPath:${ID}`,
    `memoryPath:${ID}`, `exists:/bots/${ID}/MEMORY.md`,
  ]);
});

test("only the shared files that exist are included, in order", () => {
  const onlyShared = fixture({ existing: ["/agent/BOTS.md"] });
  assert.deepEqual(botPromptSources(ID, onlyShared.deps), ["/agent/BOTS.md", `/bots/${ID}/SOUL.md`]);
  const onlyUser = fixture({ existing: ["/agent/USER.md"] });
  assert.deepEqual(botPromptSources(ID, onlyUser.deps), ["/agent/USER.md", `/bots/${ID}/SOUL.md`]);
  const neither = fixture();
  assert.deepEqual(botPromptSources(ID, neither.deps), [`/bots/${ID}/SOUL.md`]);
});

test("SOUL.md is listed even when the file does not exist", () => {
  const f = fixture();
  assert.ok(botPromptSources(ID, f.deps).includes(`/bots/${ID}/SOUL.md`));
  assert.equal(f.calls.includes(`exists:/bots/${ID}/SOUL.md`), false, "SOUL existence is never checked");
});

test("no de-duplication is applied, matching the original", () => {
  const f = fixture({ existing: ["/agent/BOTS.md", "/agent/USER.md"], overrides: { globalUserMdPath: () => "/agent/BOTS.md" } });
  assert.deepEqual(botPromptSources(ID, f.deps), ["/agent/BOTS.md", "/agent/BOTS.md", `/bots/${ID}/SOUL.md`]);
});

test("global AGENTS.md is never part of a Bot's sources", () => {
  const f = fixture({ existing: ["/agent/BOTS.md", "/agent/USER.md", "/agent/AGENTS.md", "/agent/SOUL.md", `/bots/${ID}/MEMORY.md`] });
  const sources = botPromptSources(ID, f.deps);
  assert.equal(sources.some((path) => path.endsWith("AGENTS.md")), false);
  assert.equal(sources.some((path) => path === "/agent/SOUL.md"), false, "the global SOUL.md is Code-only");
});

test("an id is only used to resolve paths, never interpolated into another path", () => {
  const f = fixture();
  botPromptSources(ID, f.deps);
  assert.deepEqual(f.calls.filter((call) => call.startsWith("soulPath")), [`soulPath:${ID}`]);
  assert.deepEqual(f.calls.filter((call) => call.startsWith("memoryPath")), [`memoryPath:${ID}`]);
});
