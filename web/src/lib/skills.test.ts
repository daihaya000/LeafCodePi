import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterSkillsByState,
  listSkills,
  readSkillsState,
  setSkillEnabled,
  SkillsError,
  skillsDir,
  writeSkillsState,
} from "./skills";

describe("filterSkillsByState", () => {
  it("drops only disabled names", () => {
    const skills = [{ name: "a" }, { name: "b" }, { name: "c" }];
    expect(filterSkillsByState(skills, { disabled: { b: true } }).map((s) => s.name)).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns a copy when nothing is disabled", () => {
    const skills = [{ name: "a" }];
    const out = filterSkillsByState(skills, { disabled: {} });
    expect(out).toEqual(skills);
    expect(out).not.toBe(skills);
  });
});

describe("listSkills / setSkillEnabled", () => {
  let agentDir = "";
  let data = "";
  let prevData: string | undefined;

  afterEach(() => {
    if (prevData === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = prevData;
    prevData = undefined;
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    if (data) rmSync(data, { recursive: true, force: true });
    agentDir = "";
    data = "";
  });

  function fixture() {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-skills-agent-"));
    data = mkdtempSync(join(tmpdir(), "leafcode-pi-skills-data-"));
    prevData = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = data;
    const dir = skillsDir(agentDir);
    for (const name of ["alpha", "beta"] as const) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(
        join(dir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
        "utf8",
      );
    }
    writeSkillsState({ disabled: {} });
    return agentDir;
  }

  it("lists discovered skills as enabled by default", () => {
    const agent = fixture();
    const listed = listSkills(agent);
    expect(listed.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(listed.skills.every((s) => s.enabled)).toBe(true);
    expect(listed.skillsDir).toBe(skillsDir(agent));
  });

  it("toggles via skills-state.json without moving folders", () => {
    const agent = fixture();
    let listed = setSkillEnabled("alpha", false, agent);
    expect(listed.skills.find((s) => s.name === "alpha")?.enabled).toBe(false);
    expect(listed.skills.find((s) => s.name === "beta")?.enabled).toBe(true);
    expect(readSkillsState().disabled).toEqual({ alpha: true });

    listed = setSkillEnabled("alpha", true, agent);
    expect(listed.skills.find((s) => s.name === "alpha")?.enabled).toBe(true);
    expect(readSkillsState().disabled).toEqual({});
  });

  it("rejects unknown skill names", () => {
    const agent = fixture();
    expect(() => setSkillEnabled("missing", false, agent)).toThrow(SkillsError);
  });
});
