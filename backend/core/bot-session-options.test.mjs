import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBotSessionOptions } from "./bot-session-options.mjs";

function input(overrides = {}) {
  return {
    isBot: true,
    promptSources: ["soul", "user"],
    roomOrigin: false,
    roomSystemPrompt: "ROOM",
    skills: undefined,
    tools: undefined,
    defaultToolNames: ["read", "powershell", "write"],
    platform: "win32",
    ...overrides,
  };
}

test("a non-Bot session gets no options at all", () => {
  assert.equal(resolveBotSessionOptions(input({ isBot: false })), null);
  for (const value of [undefined, null, 0, "true", 1]) {
    assert.equal(resolveBotSessionOptions(input({ isBot: value })), null, String(value));
  }
});

test("prompt sources keep their order and context files are off", () => {
  const options = resolveBotSessionOptions(input({ promptSources: ["a", "b", "c"] }));
  assert.deepEqual(options.appendSystemPrompt, ["a", "b", "c"]);
  assert.equal(options.noContextFiles, true);
  assert.equal(options.skillScope, "bot");
  assert.equal(options.botSkills, undefined);
});

test("the Room prompt is appended last, and only for a Room origin", () => {
  assert.deepEqual(resolveBotSessionOptions(input({ roomOrigin: true })).appendSystemPrompt, ["soul", "user", "ROOM"]);
  assert.deepEqual(resolveBotSessionOptions(input({ roomOrigin: false })).appendSystemPrompt, ["soul", "user"]);
  for (const value of [undefined, null, 0, "true"]) {
    assert.deepEqual(resolveBotSessionOptions(input({ roomOrigin: value })).appendSystemPrompt, ["soul", "user"], String(value));
  }
});

test("an unset tool list falls back to the defaults", () => {
  assert.deepEqual(resolveBotSessionOptions(input()).botTools, ["read", "powershell", "write"]);
  assert.deepEqual(resolveBotSessionOptions(input({ tools: [] })).botTools, [], "an explicitly empty list stays empty");
  assert.deepEqual(resolveBotSessionOptions(input({ tools: ["read"] })).botTools, ["read"]);
});

test("powershell is dropped off Windows and kept elsewhere, other tools untouched", () => {
  const tools = ["read", "powershell", "write", "powershell"];
  assert.deepEqual(resolveBotSessionOptions(input({ tools, platform: "win32" })).botTools, tools);
  assert.deepEqual(resolveBotSessionOptions(input({ tools, platform: "linux" })).botTools, ["read", "write"]);
  assert.deepEqual(resolveBotSessionOptions(input({ tools: ["read"], platform: "darwin" })).botTools, ["read"]);
});

test("bot skills are passed through as configured", () => {
  const skills = { include: ["a"], exclude: ["b"] };
  assert.equal(resolveBotSessionOptions(input({ skills })).botSkills, skills);
});
