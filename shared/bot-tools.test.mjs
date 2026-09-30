import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_DEFAULT_DISABLED_TOOL_NAMES,
  BOT_DEFAULT_TOOL_NAMES,
  BOT_TOOL_NAMES,
} from "./bot-tools.mjs";

test("the Bot tool vocabulary is unchanged", () => {
  assert.deepEqual([...BOT_TOOL_NAMES], [
    "read", "write", "edit", "bash", "powershell", "question", "grep", "find", "ls",
    "memory_search", "memory_add", "memory_replace", "memory_remove", "session_search",
    "skill_manage", "subagent", "todowrite", "tool_search", "jev_judge", "intercom",
    "web_search", "source_check", "fetch_content", "get_search_content", "contact_supervisor",
    "subagent_wait", "structured_output", "task_mutation_decision", "watchdog_permission_decision",
    "watchdog_warn", "mcp",
  ]);
});

test("the default-disabled list is unchanged and stays inside the vocabulary", () => {
  assert.deepEqual([...BOT_DEFAULT_DISABLED_TOOL_NAMES], [
    "write", "edit", "bash", "powershell", "subagent", "todowrite",
    "contact_supervisor", "subagent_wait", "structured_output", "task_mutation_decision",
    "watchdog_permission_decision", "watchdog_warn",
  ]);
  for (const tool of BOT_DEFAULT_DISABLED_TOOL_NAMES) {
    assert.ok(BOT_TOOL_NAMES.includes(tool), `${tool} must be a known tool`);
  }
});

test("the defaults are exactly the vocabulary minus the disabled tools, in order", () => {
  const disabled = new Set(BOT_DEFAULT_DISABLED_TOOL_NAMES);
  assert.deepEqual([...BOT_DEFAULT_TOOL_NAMES], BOT_TOOL_NAMES.filter((tool) => !disabled.has(tool)));
  assert.equal(BOT_DEFAULT_TOOL_NAMES.includes("read"), true);
  assert.equal(BOT_DEFAULT_TOOL_NAMES.includes("write"), false);
  assert.equal(new Set(BOT_TOOL_NAMES).size, BOT_TOOL_NAMES.length, "no duplicates");
});

test("the vocabulary is plain data the Backend can read", () => {
  // The point of this module: a .mjs the Backend process imports directly, with no TypeScript step.
  for (const list of [BOT_TOOL_NAMES, BOT_DEFAULT_DISABLED_TOOL_NAMES, BOT_DEFAULT_TOOL_NAMES]) {
    assert.ok(Array.isArray(list));
    for (const tool of list) assert.equal(typeof tool, "string");
  }
});
