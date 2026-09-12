import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codePromptSources,
  globalAgentsMdPath,
  globalBotsMdPath,
  globalSoulMdPath,
  globalUserMdPath,
  MAX_AGENTS_MD_BYTES,
  readAgentsMdFile,
  readGlobalAgentsMd,
  readGlobalBotsMd,
  readGlobalSoulMd,
  readGlobalUserMd,
  resolvePiAgentDir,
  writeAgentsMdFile,
  writeGlobalAgentsMd,
  writeGlobalBotsMd,
  writeGlobalSoulMd,
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
