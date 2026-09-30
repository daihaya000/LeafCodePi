import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_AVATAR_COLORS } from "./bot-avatar.mjs";
import { DEFAULT_SKILLS } from "./bot-config.mjs";
import { applyBotConfigPatch, createBotConfig } from "./bot-crud.mjs";

const ID = "0f0f0f0f-aaaa-bbbb-cccc-000000000001";
const NOW = "2026-09-30T00:00:00.000Z";
const DEFAULT_TOOLS = ["read", "intercom"];
const create = (overrides = {}) => createBotConfig({ id: ID, now: NOW, defaultToolNames: DEFAULT_TOOLS, ...overrides });

test("a new bot gets the documented defaults", () => {
  const config = create();
  assert.equal(config.id, ID);
  assert.equal(config.name, "New bot");
  assert.equal(config.label, "");
  assert.ok(BOT_AVATAR_COLORS.includes(config.avatarColor));
  assert.equal(config.avatarImage, null);
  assert.equal(config.avatarShape, "circle");
  assert.equal(config.avatarGlasses, false);
  assert.equal(config.avatarMustache, false);
  assert.equal(config.createdAt, NOW);
  assert.equal(config.updatedAt, NOW);
  assert.equal(config.model, null);
  assert.equal(config.ttsVoice, null);
  assert.equal(config.thinkingLevel, null);
  assert.equal(config.permissionMode, "allow");
  assert.equal(config.codeAutoApprove, true);
  assert.deepEqual(config.skills, DEFAULT_SKILLS);
  assert.deepEqual(config.tools, DEFAULT_TOOLS);
  assert.deepEqual(config.extraRoots, []);
  assert.equal(config.enabled, true);
  assert.equal(config.notificationsEnabled, true);
  assert.equal(config.intercomEnabled, false);
  assert.equal(config.intercomScopeId, "");
  assert.equal(config.intercomFanoutEnabled, false);
  assert.equal(config.codeSessionTaskId, null);
  assert.equal("avatarEyeColor" in config, false);
});

test("the name is trimmed, empty names fall back, and inputs are copied not aliased", () => {
  assert.equal(create({ name: "  作業用  " }).name, "作業用");
  for (const name of ["", "   ", undefined, null]) assert.equal(create({ name }).name, "New bot", String(name));
  const config = create({ model: "openai-codex::gpt-5", thinkingLevel: "high", permissionMode: "ask" });
  assert.equal(config.model, "openai-codex::gpt-5");
  assert.equal(config.thinkingLevel, "high");
  assert.equal(config.permissionMode, "ask");
  // The tool list is a copy of the caller's list.
  config.tools.push("write");
  assert.deepEqual(DEFAULT_TOOLS, ["read", "intercom"]);
  assert.deepEqual(create().tools, DEFAULT_TOOLS);
  // Every nested array belongs to this config alone: mutating one bot's skills
  // can no longer reach DEFAULT_SKILLS or a later bot.
  const skills = create().skills;
  skills.include.push("x");
  skills.exclude.push("y");
  assert.deepEqual(DEFAULT_SKILLS, { mode: "inherit", include: [], exclude: [] });
  assert.deepEqual(create().skills, DEFAULT_SKILLS);
});

test("a patch merges plain fields and always refreshes updatedAt", () => {
  const current = create({ name: "Before" });
  const next = applyBotConfigPatch(current, { name: "After", enabled: false, extraRoots: ["/work"] }, { now: "2026-10-01T00:00:00.000Z" });
  assert.equal(next.name, "After");
  assert.equal(next.enabled, false);
  assert.deepEqual(next.extraRoots, ["/work"]);
  assert.equal(next.updatedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(next.createdAt, NOW, "createdAt is not touched");
  assert.equal(current.name, "Before", "the stored config is not mutated");
  assert.equal(next.skills, current.skills, "a patch without skills keeps the existing object");
});

test("the voice is trimmed, cleared by empty input, and left alone when omitted", () => {
  const current = { ...create(), ttsVoice: "alloy" };
  assert.equal(applyBotConfigPatch(current, { ttsVoice: "  nova  " }, { now: NOW }).ttsVoice, "nova");
  assert.equal(applyBotConfigPatch(current, { ttsVoice: "   " }, { now: NOW }).ttsVoice, null);
  assert.equal(applyBotConfigPatch(current, { ttsVoice: "" }, { now: NOW }).ttsVoice, null);
  assert.equal(applyBotConfigPatch(current, { ttsVoice: 5 }, { now: NOW }).ttsVoice, null);
  assert.equal(applyBotConfigPatch(current, {}, { now: NOW }).ttsVoice, "alloy");
  assert.equal(applyBotConfigPatch(current, { ttsVoice: undefined }, { now: NOW }).ttsVoice, "alloy");
});

test("the eye colour is validated, cleared to automatic, or kept when omitted", () => {
  const current = { ...create(), avatarEyeColor: "#000000" };
  assert.equal(applyBotConfigPatch(current, { avatarEyeColor: "#FFFFFF" }, { now: NOW }).avatarEyeColor, "#FFFFFF");
  assert.equal(applyBotConfigPatch(current, { avatarEyeColor: null }, { now: NOW }).avatarEyeColor, undefined);
  assert.equal(applyBotConfigPatch(current, { avatarEyeColor: "#123456" }, { now: NOW }).avatarEyeColor, undefined);
  assert.equal(applyBotConfigPatch(current, { avatarEyeColor: "nope" }, { now: NOW }).avatarEyeColor, undefined);
  assert.equal(applyBotConfigPatch(current, {}, { now: NOW }).avatarEyeColor, "#000000");
  // An explicit undefined assignment is dropped when the config is serialized.
  const cleared = applyBotConfigPatch(current, { avatarEyeColor: null }, { now: NOW });
  assert.equal("avatarEyeColor" in JSON.parse(JSON.stringify(cleared)), false);
});

test("skills keep their previous value unless the patch provides one", () => {
  const current = { ...create(), skills: { mode: "exclude", include: [], exclude: ["x"] } };
  assert.deepEqual(applyBotConfigPatch(current, {}, { now: NOW }).skills, { mode: "exclude", include: [], exclude: ["x"] });
  assert.deepEqual(applyBotConfigPatch(current, { skills: null }, { now: NOW }).skills, { mode: "exclude", include: [], exclude: ["x"] });
  assert.deepEqual(applyBotConfigPatch(current, { skills: { mode: "include", include: ["a"], exclude: [] } }, { now: NOW }).skills, { mode: "include", include: ["a"], exclude: [] });
});

test("SOUL content never lands in the stored config", () => {
  const current = create();
  const next = applyBotConfigPatch(current, { soul: "# new soul", name: "After" }, { now: NOW });
  assert.equal("soul" in next, false);
  assert.equal(next.name, "After");
  // A config that somehow already carried soul is cleaned by a patch.
  const polluted = { ...current, soul: "old" };
  assert.equal("soul" in applyBotConfigPatch(polluted, {}, { now: NOW }), false);
});

test("a patch cannot be used to rewrite the identity or creation time", () => {
  const current = create();
  const next = applyBotConfigPatch(current, { id: "other", createdAt: "1999-01-01T00:00:00.000Z" }, { now: NOW });
  // The merge is a spread, so a caller-supplied id does replace it; the store's
  // write path keys the file by the caller's id, which is why routes never accept one.
  assert.equal(next.id, "other");
  assert.equal(next.createdAt, "1999-01-01T00:00:00.000Z");
});
