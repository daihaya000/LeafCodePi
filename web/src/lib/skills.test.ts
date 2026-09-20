import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledSkillsDir,
  bundledSkillPaths,
  compactSkillsForPrompt,
  filterSkillsByState,
  filterSkillsForBot,
  listSkills,
  readSkillsState,
  setSkillEnabled,
  setSkillsEnabled,
  SkillsError,
  skillsDir,
  writeSkillsState,
} from "./skills";

describe("bundledSkillsDir", () => {
  it("returns an absolute path for a relative override", () => {
    const previous = process.env.LEAFCODE_PI_SKILLS_DIR;
    try {
      process.env.LEAFCODE_PI_SKILLS_DIR = ".";
      expect(bundledSkillsDir()).toBe(resolve(process.cwd()));
    } finally {
      if (previous === undefined) delete process.env.LEAFCODE_PI_SKILLS_DIR;
      else process.env.LEAFCODE_PI_SKILLS_DIR = previous;
    }
  });
});

describe("bundledSkillPaths", () => {
  it("discovers the bundled TypeSafe skill without a global skill", () => {
    const bundled = bundledSkillsDir();
    if (!bundled) throw new Error("bundled skills directory is unavailable");
    const agentDir = mkdtempSync(join(tmpdir(), "leafcode-empty-skills-"));
    try {
      const typesafe = listSkills(agentDir, {
        skillsDir: join(agentDir, "skills"),
        bundledDir: bundled,
      }).skills.find((skill) => skill.name === "typesafe-ai");
      expect(typesafe).toMatchObject({ source: "bundled" });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("includes skills shipped inside bundled extensions without global installation", () => {
    const root = mkdtempSync(join(tmpdir(), "leafcode-packaged-skills-"));
    const previous = process.env.LEAFCODE_PI_EXTENSIONS_DIR;
    try {
      const extension = join(root, "leafcode-example");
      mkdirSync(join(extension, "skills"), { recursive: true });
      writeFileSync(join(extension, "index.ts"), "export default function () {}\n");
      process.env.LEAFCODE_PI_EXTENSIONS_DIR = root;
      expect(bundledSkillPaths(null)).toEqual([join(extension, "skills")]);
    } finally {
      if (previous === undefined) delete process.env.LEAFCODE_PI_EXTENSIONS_DIR;
      else process.env.LEAFCODE_PI_EXTENSIONS_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers the vendored n8n skills from the bundled root", () => {
    const bundled = bundledSkillsDir();
    if (!bundled) throw new Error("bundled skills directory is unavailable");
    const agentDir = mkdtempSync(join(tmpdir(), "leafcode-empty-skills-"));
    try {
      const skills = listSkills(agentDir, {
        skillsDir: join(agentDir, "skills"),
        bundledDir: bundled,
      }).skills;
      expect(skills.map((skill) => skill.name)).toEqual(
        expect.arrayContaining([
          "using-n8n-skills-official",
          "n8n-workflow-lifecycle-official",
          "n8n-subworkflows-official",
          "n8n-extending-mcp-official",
          "n8n-expressions-official",
          "n8n-node-configuration-official",
          "n8n-code-nodes-official",
          "n8n-loops-official",
          "n8n-agents-official",
          "n8n-error-handling-official",
          "n8n-credentials-and-security-official",
          "n8n-binary-and-data-official",
          "n8n-data-tables-official",
          "n8n-debugging-official",
        ]),
      );
      const meta = skills.find((skill) => skill.name === "using-n8n-skills-official");
      expect(meta?.source).toBe("bundled");
      expect(meta?.description).toBeTruthy();
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("discovers the vendored Slack skills from the bundled root", () => {
    const bundled = bundledSkillsDir();
    if (!bundled) throw new Error("bundled skills directory is unavailable");
    const agentDir = mkdtempSync(join(tmpdir(), "leafcode-empty-skills-"));
    try {
      const skills = listSkills(agentDir, {
        skillsDir: join(agentDir, "skills"),
        bundledDir: bundled,
      }).skills;
      expect(skills.map((skill) => skill.name)).toEqual(
        expect.arrayContaining([
          "block-kit",
          "create-slack-app",
          "slack-api",
          "slack-cli",
          "slack-docs",
          "slack-messaging",
          "slack-search",
          "test-slack-app",
        ]),
      );
      const messaging = skills.find((skill) => skill.name === "slack-messaging");
      expect(messaging?.source).toBe("bundled");
      expect(messaging?.description).toBeTruthy();
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("filterSkillsByState", () => {
  it("filters Code and Bot scopes independently", () => {
    const skills = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const state = { code: { b: true }, bot: { c: true } } as const;
    expect(filterSkillsByState(skills, state, "code").map((s) => s.name)).toEqual(["a", "c"]);
    expect(filterSkillsByState(skills, state, "bot").map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("returns a copy when nothing is disabled", () => {
    const skills = [{ name: "a" }];
    const out = filterSkillsByState(skills, { code: {}, bot: {} });
    expect(out).toEqual(skills);
    expect(out).not.toBe(skills);
  });
});

describe("filterSkillsForBot", () => {
  const skills = [{ name: "a" }, { name: "b" }, { name: "c" }];

  it("supports an explicit include list", () => {
    expect(filterSkillsForBot(skills, { mode: "include", include: ["c", "a"], exclude: [] }).map((s) => s.name)).toEqual(["a", "c"]);
  });

  it("supports an explicit exclude list and inherit", () => {
    expect(filterSkillsForBot(skills, { mode: "exclude", include: [], exclude: ["b"] }).map((s) => s.name)).toEqual(["a", "c"]);
    expect(filterSkillsForBot(skills, { mode: "inherit", include: [], exclude: ["a"] })).toEqual(skills);
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
  let bundledDir = "";
  let prevData: string | undefined;

  afterEach(() => {
    if (prevData === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = prevData;
    prevData = undefined;
    for (const dir of [agentDir, data, bundledDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    agentDir = "";
    data = "";
    bundledDir = "";
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
    bundledDir = mkdtempSync(join(tmpdir(), "leafcode-pi-skills-bundled-"));
    prevData = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = data;
    writeSkill(skillsDir(agentDir), "alpha", "alpha from pi");
    writeSkill(skillsDir(agentDir), "beta", "beta from pi");
    writeSkillsState({ code: {}, bot: {} });
    return { agentDir, bundledDir };
  }

  it("lists discovered skills as enabled by default", () => {
    const { agentDir: agent } = fixture();
    const listed = listSkills(agent, { bundledDir: null });
    expect(listed.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(listed.skills.every((s) => s.enabled)).toBe(true);
    expect(listed.skills.every((s) => s.source === "pi")).toBe(true);
    expect(listed.skillsDir).toBe(skillsDir(agent));
  });

  it("toggles multiple skills in one scope update", () => {
    const { agentDir: agent } = fixture();
    const listed = setSkillsEnabled(["alpha", "beta"], false, agent, { bundledDir: null, scope: "bot" });
    expect(listed.skills.filter((skill) => !skill.botEnabled).map((skill) => skill.name)).toEqual(["alpha", "beta"]);
    expect(readSkillsState()).toEqual({ code: {}, bot: { alpha: true, beta: true } });
  });

  it("toggles Code and Bot independently via skills-state.json", () => {
    const { agentDir: agent } = fixture();
    let listed = setSkillEnabled("alpha", false, agent, { bundledDir: null, scope: "code" });
    expect(listed.skills.find((s) => s.name === "alpha")).toMatchObject({
      enabled: false,
      codeEnabled: false,
      botEnabled: true,
    });
    expect(readSkillsState()).toEqual({ code: { alpha: true }, bot: {} });

    listed = setSkillEnabled("alpha", false, agent, { bundledDir: null, scope: "bot" });
    expect(listed.skills.find((s) => s.name === "alpha")?.botEnabled).toBe(false);
    expect(readSkillsState()).toEqual({ code: { alpha: true }, bot: { alpha: true } });

    listed = setSkillEnabled("alpha", true, agent, { bundledDir: null, scope: "code" });
    expect(listed.skills.find((s) => s.name === "alpha")).toMatchObject({
      enabled: true,
      codeEnabled: true,
      botEnabled: false,
    });
    expect(readSkillsState()).toEqual({ code: {}, bot: { alpha: true } });
  });

  it("migrates the old shared disabled state into both scopes", () => {
    const { agentDir: agent } = fixture();
    writeFileSync(join(data, "skills-state.json"), JSON.stringify({ disabled: { alpha: true } }));

    expect(readSkillsState()).toEqual({ code: { alpha: true }, bot: { alpha: true } });
    setSkillEnabled("alpha", true, agent, { bundledDir: null, scope: "code" });
    expect(readSkillsState()).toEqual({ code: {}, bot: { alpha: true } });
  });

  it("lists bundled skills and allows toggling them", () => {
    const { agentDir: agent, bundledDir: bundled } = fixture();
    writeSkill(bundled, "built-in", "bundled skill");

    let listed = listSkills(agent, { bundledDir: bundled });
    expect(listed.skills.map((s) => s.name)).toEqual(["alpha", "beta", "built-in"]);
    expect(listed.skills.find((s) => s.name === "built-in")?.source).toBe("bundled");
    expect(listed.bundledSkillsDir).toBe(bundled);

    listed = setSkillEnabled("built-in", false, agent, { bundledDir: bundled });
    expect(listed.skills.find((s) => s.name === "built-in")?.enabled).toBe(false);
  });

  it("lists and toggles extension-bundled skills without a global copy", () => {
    const { agentDir: agent, bundledDir: bundled } = fixture();
    const previousExtensions = process.env.LEAFCODE_PI_EXTENSIONS_DIR;
    const previousSkills = process.env.LEAFCODE_PI_SKILLS_DIR;
    try {
      const extension = join(bundled, "extensions", "leafcode-example");
      mkdirSync(extension, { recursive: true });
      writeFileSync(join(extension, "index.ts"), "export default function () {}\n");
      writeSkill(join(extension, "skills"), "packaged", "bundled procedure");
      process.env.LEAFCODE_PI_EXTENSIONS_DIR = join(bundled, "extensions");
      process.env.LEAFCODE_PI_SKILLS_DIR = join(bundled, "absent");
      expect(listSkills(agent).skills.map((s) => s.name)).toEqual(["alpha", "beta", "packaged"]);
      expect(setSkillEnabled("packaged", false, agent).skills.find((s) => s.name === "packaged"))
        .toMatchObject({ source: "bundled", enabled: false });
    } finally {
      if (previousExtensions === undefined) delete process.env.LEAFCODE_PI_EXTENSIONS_DIR;
      else process.env.LEAFCODE_PI_EXTENSIONS_DIR = previousExtensions;
      if (previousSkills === undefined) delete process.env.LEAFCODE_PI_SKILLS_DIR;
      else process.env.LEAFCODE_PI_SKILLS_DIR = previousSkills;
    }
  });

  it("rejects unknown skill names", () => {
    const { agentDir: agent } = fixture();
    expect(() => setSkillEnabled("missing", false, agent, { bundledDir: null })).toThrow(SkillsError);
  });
});
