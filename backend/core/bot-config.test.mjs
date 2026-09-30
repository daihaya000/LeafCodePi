import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SKILLS, isBotToolName, legacyDefaultToolSets, normalizeBotPermissionMode, normalizeBotSkills,
  normalizeBotTools, normalizeNames, parseBotConfig, shouldMigrateBotTools, SOUL_TEMPLATE, toBotDto,
} from "./bot-config.mjs";

// A small stand-in for the shared tool vocabulary: the shape of the lists is what matters.
const TOOL_NAMES = [
  "read", "write", "edit", "bash", "powershell", "subagent", "todowrite", "intercom",
  "web_search", "source_check", "fetch_content", "get_search_content", "contact_supervisor",
  "subagent_wait", "structured_output", "task_mutation_decision", "watchdog_permission_decision", "watchdog_warn", "mcp",
];
const DEFAULT_TOOL_NAMES = ["read", "web_search", "mcp", "intercom"];
const ID = "0f0f0f0f-aaaa-bbbb-cccc-000000000001";

const stored = (overrides = {}) => ({ id: ID, name: "Bot", createdAt: "c", updatedAt: "u", ...overrides });
const parse = (value, overrides = {}) => {
  const writes = [];
  const config = parseBotConfig({
    id: ID,
    readText: () => JSON.stringify(value),
    writeConfig: (next) => writes.push(next),
    toolNames: TOOL_NAMES,
    defaultToolNames: DEFAULT_TOOL_NAMES,
    ...overrides,
  });
  return { config, writes };
};

test("the legacy default sets are derived from the injected vocabulary", () => {
  const sets = legacyDefaultToolSets(TOOL_NAMES);
  assert.equal(sets.length, 7);
  for (const set of sets) {
    assert.ok(set.every((tool) => TOOL_NAMES.includes(tool)));
    assert.equal(set.includes("read"), true, "read is in every historical default");
  }
  // Each set is "every tool except a historical exclusion list", newest first.
  assert.equal(sets[0].includes("write"), false);
  assert.equal(sets[0].includes("todowrite"), false);
  assert.equal(sets[0].includes("mcp"), false);
  assert.equal(sets[0].includes("web_search"), true, "the Bot-only web tools existed before this default");
  assert.equal(sets[1].includes("todowrite"), false);
  assert.equal(sets[1].includes("mcp"), true);
  assert.equal(sets[2].includes("todowrite"), true);
  assert.equal(sets[2].includes("write"), false);
  assert.equal(sets[3].includes("web_search"), false);
  assert.equal(sets[3].includes("todowrite"), false);
  assert.equal(sets[3].includes("intercom"), true);
  assert.equal(sets[4].includes("todowrite"), true);
  assert.equal(sets.at(-1).includes("intercom"), false);
  // The oldest defaults predate both intercom and the MCP gateway.
  assert.equal(sets.at(-1).includes("mcp"), false);
  assert.equal(sets.at(-1).includes("read"), true);
});

test("only a list that matches a historical default (or is missing) is migrated", () => {
  const legacy = legacyDefaultToolSets(TOOL_NAMES)[1];
  assert.equal(shouldMigrateBotTools(undefined, [], TOOL_NAMES), true);
  assert.equal(shouldMigrateBotTools("nope", [], TOOL_NAMES), true);
  assert.equal(shouldMigrateBotTools(legacy, legacy, TOOL_NAMES), true);
  assert.equal(shouldMigrateBotTools([], [], TOOL_NAMES), false);
  assert.equal(shouldMigrateBotTools(["read", "web_search"], ["read", "web_search"], TOOL_NAMES), false);
  // A list with an unknown name is never treated as a default, even if the known part matches.
  const withUnknown = [...legacy, "future_tool"];
  assert.equal(shouldMigrateBotTools(withUnknown, withUnknown, TOOL_NAMES), false);
});

test("tool lists are trimmed, de-duplicated, and unknown names are preserved", () => {
  assert.deepEqual(normalizeBotTools(undefined, DEFAULT_TOOL_NAMES), DEFAULT_TOOL_NAMES);
  assert.deepEqual(normalizeBotTools("nope", DEFAULT_TOOL_NAMES), DEFAULT_TOOL_NAMES);
  assert.deepEqual(normalizeBotTools([" read ", "read", "", "  ", "future_tool", 7, null], DEFAULT_TOOL_NAMES), ["read", "future_tool"]);
  assert.equal(isBotToolName("read", TOOL_NAMES), true);
  assert.equal(isBotToolName("future_tool", TOOL_NAMES), false);
});

test("permission modes fail closed to ask for unknown strings but keep the allow default", () => {
  for (const mode of ["allow", "ask", "deny"]) assert.equal(normalizeBotPermissionMode(mode), mode);
  assert.equal(normalizeBotPermissionMode(undefined), "allow");
  assert.equal(normalizeBotPermissionMode(null), "allow");
  assert.equal(normalizeBotPermissionMode(""), "allow");
  assert.equal(normalizeBotPermissionMode("   "), "allow");
  assert.equal(normalizeBotPermissionMode("grant"), "ask");
  assert.equal(normalizeBotPermissionMode(1), "allow");
});

test("skills and name lists normalize to the documented default shape", () => {
  assert.deepEqual(normalizeBotSkills(undefined), DEFAULT_SKILLS);
  assert.deepEqual(normalizeBotSkills([]), DEFAULT_SKILLS);
  assert.deepEqual(normalizeBotSkills("x"), DEFAULT_SKILLS);
  assert.deepEqual(normalizeBotSkills({ mode: "weird", include: [" a ", "a", 2], exclude: "x" }), { mode: "inherit", include: ["a"], exclude: [] });
  assert.deepEqual(normalizeBotSkills({ mode: "exclude", include: [], exclude: [" b ", "b"] }), { mode: "exclude", include: [], exclude: ["b"] });
  assert.deepEqual(normalizeNames(["a", " a ", null, 3, ""]), ["a"]);
  assert.deepEqual(normalizeNames("nope"), []);
});

test("parsing fills documented defaults for a minimal record", () => {
  const { config, writes } = parse(stored());
  assert.equal(config.id, ID);
  assert.equal(config.name, "Bot");
  assert.equal(config.label, "");
  assert.equal(config.avatarImage, null);
  assert.equal(config.avatarShape, "circle");
  assert.deepEqual(config.tools, DEFAULT_TOOL_NAMES);
  assert.equal(config.model, null);
  assert.equal(config.ttsVoice, null);
  assert.equal(config.thinkingLevel, null);
  assert.equal(config.permissionMode, "allow");
  assert.equal(config.enabled, true);
  assert.equal(config.notificationsEnabled, true);
  assert.equal(config.intercomEnabled, false);
  assert.equal(config.intercomScopeId, "");
  assert.equal(config.codeAutoApprove, true);
  assert.equal(config.codeSessionTaskId, null);
  assert.deepEqual(config.extraRoots, []);
  assert.equal("avatarEyeColor" in config, false);
  // The missing legacy fields trigger the one-time migration write.
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, ID);
});

test("a record for another id, a missing name or unreadable JSON parses as null without writing", () => {
  for (const value of [{ ...stored(), id: "other" }, { id: ID }, null, 7, "x"]) {
    const { config, writes } = parse(value);
    assert.equal(config, null, JSON.stringify(value));
    assert.deepEqual(writes, []);
  }
  const writes = [];
  assert.equal(parseBotConfig({ id: ID, readText: () => "{not json", writeConfig: (next) => writes.push(next), toolNames: TOOL_NAMES, defaultToolNames: DEFAULT_TOOL_NAMES }), null);
  assert.deepEqual(writes, []);
  assert.equal(parseBotConfig({ id: ID, readText: () => { throw new Error("EACCES"); }, writeConfig: () => undefined, toolNames: TOOL_NAMES, defaultToolNames: DEFAULT_TOOL_NAMES }), null);
});

test("a migration write failing makes the read fail, as before", () => {
  const { config } = parse(stored(), { writeConfig: () => { throw new Error("disk full"); } });
  assert.equal(config, null);
});

test("values written by older builds are normalized on read and migrated once", () => {
  const legacyTools = legacyDefaultToolSets(TOOL_NAMES)[2];
  const { config, writes } = parse(stored({
    tools: legacyTools, label: 5, avatarColor: "nope", avatarImage: "https://x/y.png",
    notificationsEnabled: "yes", codeAutoApprove: "yes", avatarEyeColor: "#FFFFFF",
    ttsVoice: "  alloy  ", skills: { mode: "include", include: ["a"] },
  }));
  assert.deepEqual(config.tools, DEFAULT_TOOL_NAMES, "a legacy default allowlist is upgraded");
  assert.equal(config.label, "");
  assert.equal(config.avatarImage, null);
  assert.equal(config.avatarShape, "circle");
  assert.equal(config.avatarEyeColor, "#FFFFFF");
  assert.equal(config.ttsVoice, "alloy");
  assert.equal(config.notificationsEnabled, true);
  assert.equal(config.codeAutoApprove, true);
  assert.deepEqual(config.skills, { mode: "include", include: ["a"], exclude: [] });
  assert.equal(writes.length, 1);
  // A deliberate, unknown-name carrying list is kept as-is and not migrated.
  const deliberate = parse(stored({ tools: ["read", "future_tool"], avatarColor: "#3B82F6", label: "", notificationsEnabled: true, codeAutoApprove: true }));
  assert.deepEqual(deliberate.config.tools, ["read", "future_tool"]);
  assert.deepEqual(deliberate.writes, []);
});

test("the DTO view adds the SOUL text and filters unknown tool names without touching the file", () => {
  const { config } = parse(stored({ tools: ["read", "future_tool"] }));
  const dto = toBotDto(config, { readSoulText: () => "# custom soul", toolNames: TOOL_NAMES });
  assert.equal(dto.soul, "# custom soul");
  assert.deepEqual(dto.tools, ["read"]);
  assert.deepEqual(config.tools, ["read", "future_tool"], "the stored list keeps the unknown name");
  const legacy = toBotDto(config, { readSoulText: () => { throw new Error("ENOENT"); }, toolNames: TOOL_NAMES });
  assert.equal(legacy.soul, SOUL_TEMPLATE);
  assert.ok(SOUL_TEMPLATE.startsWith("# ボットの役割"));
});
