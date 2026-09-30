import assert from "node:assert/strict";
import { test } from "node:test";
import { filterSkillsByState, filterSkillsForBot } from "./skill-filters.mjs";

const skills = [{ name: "a" }, { name: "b" }, { name: "c" }];
const names = (list) => list.map((skill) => skill.name);

test("an empty scope state returns a copy, not the same array", () => {
  const state = { code: {}, bot: {} };
  const out = filterSkillsByState(skills, state, "code");
  assert.deepEqual(names(out), ["a", "b", "c"]);
  assert.notEqual(out, skills);
});

test("only the skills disabled in this scope are dropped", () => {
  const state = { code: { b: true, z: true }, bot: { a: true } };
  assert.deepEqual(names(filterSkillsByState(skills, state, "code")), ["a", "c"]);
  assert.deepEqual(names(filterSkillsByState(skills, state, "bot")), ["b", "c"]);
});

test("a stored false is not a disabled skill", () => {
  assert.deepEqual(names(filterSkillsByState(skills, { code: { a: false } }, "code")), ["a", "b", "c"]);
});

test("an include list keeps exactly the named skills", () => {
  assert.deepEqual(names(filterSkillsForBot(skills, { mode: "include", include: ["c", "a"] })), ["a", "c"]);
  assert.deepEqual(names(filterSkillsForBot(skills, { mode: "include", include: [] })), []);
  assert.deepEqual(names(filterSkillsForBot(skills, { mode: "include", include: ["nope"] })), []);
});

test("an exclude list drops the named skills", () => {
  assert.deepEqual(names(filterSkillsForBot(skills, { mode: "exclude", exclude: ["b"] })), ["a", "c"]);
  assert.deepEqual(names(filterSkillsForBot(skills, { mode: "exclude", exclude: [] })), ["a", "b", "c"]);
});

test("inherit (or an unknown mode) passes everything through as a copy", () => {
  for (const mode of ["inherit", "", undefined]) {
    const out = filterSkillsForBot(skills, { mode, include: ["a"], exclude: ["a"] });
    assert.deepEqual(names(out), ["a", "b", "c"], String(mode));
    assert.notEqual(out, skills);
  }
});

test("both filters preserve object identity of the skills they keep", () => {
  const out = filterSkillsForBot(filterSkillsByState(skills, { code: { b: true } }, "code"), { mode: "exclude", exclude: ["c"] });
  assert.deepEqual(out, [skills[0]]);
  assert.equal(out[0], skills[0]);
});
