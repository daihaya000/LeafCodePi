import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentsSkillsDir,
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
  let agentsHome = "";
  let prevData: string | undefined;

  afterEach(() => {
    if (prevData === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = prevData;
    prevData = undefined;
    for (const dir of [agentDir, data, agentsHome]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    agentDir = "";
    data = "";
    agentsHome = "";
  });

  function writeSkill(root: string, name: string, description: string) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
      "utf8",
    );
  }

  function fixture(opts?: { withAgents?: boolean }) {
    agentDir = mkdtempSync(join(tmpdir(), "leafcode-pi-skills-agent-"));
    data = mkdtempSync(join(tmpdir(), "leafcode-pi-skills-data-"));
    prevData = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = data;
    writeSkill(skillsDir(agentDir), "alpha", "alpha from pi");
    writeSkill(skillsDir(agentDir), "beta", "beta from pi");
    let agentsDir: string | undefined;
    if (opts?.withAgents) {
      agentsHome = mkdtempSync(join(tmpdir(), "leafcode-pi-agents-home-"));
      agentsDir = agentsSkillsDir(agentsHome);
      writeSkill(agentsDir, "insane-search", "from agents");
      writeSkill(agentsDir, "alpha", "agents duplicate");
    }
    writeSkillsState({ disabled: {} });
    return { agentDir, agentsDir };
  }

  it("lists discovered skills as enabled by default", () => {
    const { agentDir: agent } = fixture();
    // Isolate from the real ~/.agents/skills on this machine.
    const listed = listSkills(agent, {
      agentsSkillsDir: join(tmpdir(), `leafcode-pi-no-agents-${process.pid}`),
    });
    expect(listed.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(listed.skills.every((s) => s.enabled)).toBe(true);
    expect(listed.skills.every((s) => s.source === "pi")).toBe(true);
    expect(listed.skillsDir).toBe(skillsDir(agent));
  });

  it("includes ~/.agents/skills and prefers pi on name collision", () => {
    const { agentDir: agent, agentsDir } = fixture({ withAgents: true });
    const listed = listSkills(agent, { agentsSkillsDir: agentsDir });
    expect(listed.skills.map((s) => s.name)).toEqual(["alpha", "beta", "insane-search"]);
    expect(listed.skills.find((s) => s.name === "alpha")?.source).toBe("pi");
    expect(listed.skills.find((s) => s.name === "insane-search")?.source).toBe("agents");
    expect(listed.agentsSkillsDir).toBe(agentsDir);
  });

  it("toggles agents skills via skills-state.json", () => {
    const { agentDir: agent, agentsDir } = fixture({ withAgents: true });
    const opts = { agentsSkillsDir: agentsDir };
    let listed = setSkillEnabled("insane-search", false, agent, opts);
    expect(listed.skills.find((s) => s.name === "insane-search")?.enabled).toBe(false);
    expect(readSkillsState().disabled).toEqual({ "insane-search": true });

    listed = setSkillEnabled("insane-search", true, agent, opts);
    expect(listed.skills.find((s) => s.name === "insane-search")?.enabled).toBe(true);
    expect(readSkillsState().disabled).toEqual({});
  });

  it("rejects unknown skill names", () => {
    const { agentDir: agent } = fixture();
    expect(() =>
      setSkillEnabled("missing", false, agent, {
        agentsSkillsDir: join(tmpdir(), `leafcode-pi-no-agents-${process.pid}`),
      }),
    ).toThrow(SkillsError);
  });
});
