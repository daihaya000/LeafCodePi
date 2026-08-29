import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compactSkillsForPrompt,
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

describe("compactSkillsForPrompt", () => {
  it("normalizes and caps only the prompt copy", () => {
    const source = [{ name: "long", description: `Use this skill  when needed. ${"trigger ".repeat(40)}` }];

    const [compacted] = compactSkillsForPrompt(source);

    expect([...compacted.description].length).toBeLessThanOrEqual(200);
    expect(compacted.description.endsWith("…")).toBe(true);
    expect(source[0].description).toContain("  ");
  });

  it("keeps short descriptions intact", () => {
    const source = [{ name: "short", description: "Use for tests." }];
    expect(compactSkillsForPrompt(source)[0]).toBe(source[0]);
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
    for (const dir of [agentDir, data]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    agentDir = "";
    data = "";
  });

  function writeSkill(root: string, name: string, description: string) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
      "utf8",
    );
  }

  function fixture() {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-skills-agent-"));
    data = mkdtempSync(join(tmpdir(), "leafcode-pi-skills-data-"));
    prevData = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = data;
    writeSkill(skillsDir(agentDir), "alpha", "alpha from pi");
    writeSkill(skillsDir(agentDir), "beta", "beta from pi");
    writeSkillsState({ disabled: {} });
    return { agentDir };
  }

  it("lists discovered skills as enabled by default", () => {
    const { agentDir: agent } = fixture();
    const listed = listSkills(agent);
    expect(listed.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(listed.skills.every((s) => s.enabled)).toBe(true);
    expect(listed.skills.every((s) => s.source === "pi")).toBe(true);
    expect(listed.skillsDir).toBe(skillsDir(agent));
  });

  it("toggles skills via skills-state.json", () => {
    const { agentDir: agent } = fixture();
    let listed = setSkillEnabled("alpha", false, agent);
    expect(listed.skills.find((s) => s.name === "alpha")?.enabled).toBe(false);
    expect(readSkillsState().disabled).toEqual({ alpha: true });

    listed = setSkillEnabled("alpha", true, agent);
    expect(listed.skills.find((s) => s.name === "alpha")?.enabled).toBe(true);
    expect(readSkillsState().disabled).toEqual({});
  });

  it("rejects unknown skill names", () => {
    const { agentDir: agent } = fixture();
    expect(() => setSkillEnabled("missing", false, agent)).toThrow(SkillsError);
  });
});
