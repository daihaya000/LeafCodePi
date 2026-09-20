import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codeOnDemandPrompt,
  codePromptSources,
  globalAgentsMdPath,
  globalBotsMdPath,
  globalDesignMdPath,
  globalSoulMdPath,
  globalToolsMdPath,
  globalUserMdPath,
  globalWorkflowMdPath,
  readGlobalWorkflowMd,
  writeGlobalWorkflowMd,
  MAX_AGENTS_MD_BYTES,
  readAgentsMdFile,
  readGlobalAgentsMd,
  readGlobalBotsMd,
  readGlobalDesignMd,
  readGlobalSoulMd,
  readGlobalToolsMd,
  readGlobalUserMd,
  resolvePiAgentDir,
  writeAgentsMdFile,
  writeGlobalAgentsMd,
  writeGlobalBotsMd,
  writeGlobalDesignMd,
  writeGlobalSoulMd,
  writeGlobalToolsMd,
  writeGlobalUserMd,
} from "./agents-md";

describe("agents-md (global)", () => {
  it("resolves Pi agent dir from env or ~/.pi/agent", () => {
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "C:\\custom\\agent" })).toMatch(
      /custom[/\\]agent$/i,
    );
    expect(globalAgentsMdPath({ PI_CODING_AGENT_DIR: "C:\\custom\\agent" })).toMatch(
      /custom[/\\]agent[/\\]AGENTS\.md$/i,
    );
  });

  it("reads missing file as empty", () => {
    const dir = join(tmpdir(), `leafcode-pi-agents-${Date.now()}-missing`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "AGENTS.md");
    expect(readAgentsMdFile(path)).toMatchObject({ exists: false, content: "" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes and reads AGENTS.md via PI_CODING_AGENT_DIR", () => {
    const dir = join(tmpdir(), `leafcode-pi-agents-${Date.now()}-rw`);
    mkdirSync(dir, { recursive: true });
    const env = { PI_CODING_AGENT_DIR: dir };
    expect(readGlobalAgentsMd(env).exists).toBe(false);
    writeGlobalAgentsMd("# Hello\n", env);
    expect(readGlobalAgentsMd(env)).toMatchObject({ exists: true, content: "# Hello\n" });
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# Hello\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps SOUL.md and USER.md separate from AGENTS.md in the same agent dir", () => {
    const dir = join(tmpdir(), `leafcode-pi-agents-${Date.now()}-soul-user`);
    mkdirSync(dir, { recursive: true });
    const env = { PI_CODING_AGENT_DIR: dir };
    expect(globalSoulMdPath(env)).toMatch(/SOUL\.md$/);
    expect(globalUserMdPath(env)).toMatch(/USER\.md$/);
    writeGlobalAgentsMd("# Agents\n", env);
    writeGlobalSoulMd("# Soul\n", env);
    writeGlobalUserMd("# User\n", env);
    expect(readGlobalSoulMd(env)).toMatchObject({ exists: true, content: "# Soul\n" });
    expect(readGlobalUserMd(env)).toMatchObject({ exists: true, content: "# User\n" });
    expect(readGlobalAgentsMd(env).content).toBe("# Agents\n");
    expect(readFileSync(join(dir, "SOUL.md"), "utf8")).toBe("# Soul\n");
    expect(readFileSync(join(dir, "USER.md"), "utf8")).toBe("# User\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns only existing SOUL.md/USER.md paths as Code prompt sources", () => {
    const dir = join(tmpdir(), `leafcode-pi-agents-${Date.now()}-sources`);
    mkdirSync(dir, { recursive: true });
    expect(codePromptSources(dir)).toEqual([]);
    writeFileSync(join(dir, "SOUL.md"), "# Soul\n", "utf8");
    expect(codePromptSources(dir)).toEqual([join(dir, "SOUL.md")]);
    writeFileSync(join(dir, "USER.md"), "# User\n", "utf8");
    expect(codePromptSources(dir)).toEqual([join(dir, "SOUL.md"), join(dir, "USER.md")]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps BOTS.md separate from AGENTS.md in the same agent dir", () => {
    const dir = join(tmpdir(), `leafcode-pi-agents-${Date.now()}-bots`);
    mkdirSync(dir, { recursive: true });
    const env = { PI_CODING_AGENT_DIR: dir };
    expect(globalBotsMdPath(env)).toMatch(/BOTS\.md$/);
    writeGlobalAgentsMd("# Agents\n", env);
    writeGlobalBotsMd("# Bots\n", env);
    expect(readGlobalBotsMd(env)).toMatchObject({ exists: true, content: "# Bots\n" });
    expect(readGlobalAgentsMd(env).content).toBe("# Agents\n");
    expect(readFileSync(join(dir, "BOTS.md"), "utf8")).toBe("# Bots\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores TOOLS.md and DESIGN.md as separate optional references", () => {
    const dir = join(tmpdir(), `leafcode-pi-agents-${Date.now()}-optional`);
    mkdirSync(dir, { recursive: true });
    const env = { PI_CODING_AGENT_DIR: dir };
    expect(globalToolsMdPath(env)).toMatch(/TOOLS\.md$/);
    expect(globalDesignMdPath(env)).toMatch(/DESIGN\.md$/);
    writeGlobalToolsMd("# Tools\n", env);
    writeGlobalDesignMd("# Design\n", env);
    expect(readGlobalToolsMd(env)).toMatchObject({ exists: true, content: "# Tools\n" });
    expect(readGlobalDesignMd(env)).toMatchObject({ exists: true, content: "# Design\n" });
    expect(readFileSync(join(dir, "TOOLS.md"), "utf8")).toBe("# Tools\n");
    expect(readFileSync(join(dir, "DESIGN.md"), "utf8")).toBe("# Design\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps WORKFLOW.md editable but out of always-loaded prompt sources", () => {
    const dir = join(tmpdir(), `leafcode-pi-agents-${Date.now()}-workflow`);
    mkdirSync(dir, { recursive: true });
    try {
      const env = { PI_CODING_AGENT_DIR: dir };
      expect(readGlobalWorkflowMd(env).exists).toBe(false);
      writeGlobalWorkflowMd("# Unique workflow content\n", env);
      expect(readGlobalWorkflowMd(env)).toMatchObject({ exists: true, content: "# Unique workflow content\n" });
      expect(globalWorkflowMdPath(env)).toBe(join(dir, "WORKFLOW.md"));
      expect(codePromptSources(dir)).toEqual([]);
      expect(codeOnDemandPrompt(dir)).not.toContain("Unique workflow content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advertises optional files without loading their contents", () => {
    const prompt = codeOnDemandPrompt("C:\\pi\\agent");
    expect(prompt).toContain("TOOLS.md");
    expect(prompt).toContain("DESIGN.md");
    expect(prompt).toContain("C:/pi/agent/TOOLS.md");
    expect(prompt).toContain("C:/pi/agent/WORKFLOW.md");
    expect(prompt).toContain("read before changes, verification, or Git operations");
    expect(prompt).toContain("not loaded automatically");
  });

  it("names the offending file in size errors", () => {
    const dir = join(tmpdir(), `leafcode-pi-agents-${Date.now()}-bots-big`);
    mkdirSync(dir, { recursive: true });
    expect(() =>
      writeGlobalBotsMd("x".repeat(MAX_AGENTS_MD_BYTES + 1), { PI_CODING_AGENT_DIR: dir }),
    ).toThrow(/BOTS\.md/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects oversized content", () => {
    const dir = join(tmpdir(), `leafcode-pi-agents-${Date.now()}-big`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "AGENTS.md");
    expect(() => writeAgentsMdFile(path, "x".repeat(MAX_AGENTS_MD_BYTES + 1))).toThrow(/2MB/);
    rmSync(dir, { recursive: true, force: true });
  });
});
