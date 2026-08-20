import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globalAgentsMdPath,
  MAX_AGENTS_MD_BYTES,
  readAgentsMdFile,
  readGlobalAgentsMd,
  resolvePiAgentDir,
  writeAgentsMdFile,
  writeGlobalAgentsMd,
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

  it("rejects oversized content", () => {
    const dir = join(tmpdir(), `leafcode-pi-agents-${Date.now()}-big`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "AGENTS.md");
    expect(() => writeAgentsMdFile(path, "x".repeat(MAX_AGENTS_MD_BYTES + 1))).toThrow(/2MB/);
    rmSync(dir, { recursive: true, force: true });
  });
});
