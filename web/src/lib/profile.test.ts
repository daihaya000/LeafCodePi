import { gunzipSync, gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportProfile, importProfile } from "@/lib/profile";

const roots: string[] = [];

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "leafcode-profile-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("profile", () => {
  it("exports and replaces only managed configuration files", () => {
    const source = directory();
    const sourceAgent = join(source, "agent");
    const sourceData = join(source, "data");
    mkdirSync(join(sourceAgent, "agents"), { recursive: true });
    mkdirSync(join(sourceData, "settings"), { recursive: true });
    writeFileSync(join(sourceAgent, "AGENTS.md"), "source instructions", "utf8");
    writeFileSync(join(sourceAgent, "DESIGN.md"), "source design", "utf8");
    writeFileSync(join(sourceAgent, "TOOLS.md"), "source tools", "utf8");
    writeFileSync(join(sourceAgent, "WORKFLOW.md"), "source workflow", "utf8");
    writeFileSync(join(sourceAgent, "agents", "reviewer.md"), "reviewer", "utf8");
    writeFileSync(join(sourceAgent, "auth.json"), '{"token":"secret"}', "utf8");
    writeFileSync(join(sourceData, "permission-gate.json"), '{"mode":"ask"}', "utf8");
    writeFileSync(join(sourceData, "provider-endpoints.json"), '{"leafcodecloud":"https://example.test/v1"}', "utf8");
    writeFileSync(join(sourceData, "provider-model-state.json"), '{"disabled":{}}', "utf8");
    writeFileSync(join(sourceData, "provider-routing.json"), '{"version":1,"modes":{}}', "utf8");
    writeFileSync(join(sourceData, "skills-state.json"), '{"code":{},"bot":{}}', "utf8");
    writeFileSync(join(sourceData, "web-settings.json"), '{"version":1}', "utf8");
    writeFileSync(join(sourceData, "settings", "llama-server.json"), '{"value":"configured"}', "utf8");
    writeFileSync(join(sourceData, "store.json"), '{"projects":[]}', "utf8");

    const exported = exportProfile({ agentDir: sourceAgent, leafcodeDir: sourceData });
    expect(exported.summary.fileCount).toBe(13);
    const archive = JSON.parse(gunzipSync(exported.archive).toString("utf8")) as { modes?: Record<string, unknown> };
    expect(archive.modes?.["agent/AGENTS.md"]).toEqual(expect.any(Number));

    const target = directory();
    const targetAgent = join(target, "agent");
    const targetData = join(target, "data");
    mkdirSync(join(targetAgent, "skills"), { recursive: true });
    mkdirSync(join(targetData, "settings"), { recursive: true });
    writeFileSync(join(targetAgent, "AGENTS.md"), "old", "utf8");
    writeFileSync(join(targetAgent, "DESIGN.md"), "old design", "utf8");
    writeFileSync(join(targetAgent, "skills", "old.md"), "old skill", "utf8");
    writeFileSync(join(targetData, "permission-gate.json"), '{"mode":"allow"}', "utf8");
    writeFileSync(join(targetData, "skills-state.json"), '{"code":{"old":true}}', "utf8");
    writeFileSync(join(targetData, "settings", "old.json"), "old", "utf8");
    writeFileSync(join(targetData, "store.json"), '{"projects":["keep"]}', "utf8");

    const restored = importProfile(exported.archive, { agentDir: targetAgent, leafcodeDir: targetData });
    expect(restored).toEqual(exported.summary);
    expect(readFileSync(join(targetAgent, "AGENTS.md"), "utf8")).toBe("source instructions");
    expect(readFileSync(join(targetAgent, "DESIGN.md"), "utf8")).toBe("source design");
    expect(readFileSync(join(targetAgent, "TOOLS.md"), "utf8")).toBe("source tools");
    expect(readFileSync(join(targetAgent, "WORKFLOW.md"), "utf8")).toBe("source workflow");
    expect(readFileSync(join(targetAgent, "agents", "reviewer.md"), "utf8")).toBe("reviewer");
    expect(existsSync(join(targetAgent, "skills", "old.md"))).toBe(false);
    expect(readFileSync(join(targetData, "permission-gate.json"), "utf8")).toBe('{"mode":"ask"}');
    expect(readFileSync(join(targetData, "skills-state.json"), "utf8")).toBe('{"code":{},"bot":{}}');
    expect(readFileSync(join(targetData, "settings", "llama-server.json"), "utf8")).toBe('{"value":"configured"}');
    expect(existsSync(join(targetData, "settings", "old.json"))).toBe(false);
    expect(readFileSync(join(targetData, "store.json"), "utf8")).toBe('{"projects":["keep"]}');
  });

  it("imports profiles created before executable modes were stored", () => {
    const target = directory();
    const targetAgent = join(target, "agent");
    const archive = gzipSync(Buffer.from(JSON.stringify({
      format: "leafcode-pi-profile",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      files: { "agent/AGENTS.md": Buffer.from("legacy").toString("base64") },
    })));

    importProfile(archive, { agentDir: targetAgent, leafcodeDir: join(target, "data") });
    expect(readFileSync(join(targetAgent, "AGENTS.md"), "utf8")).toBe("legacy");
  });

  it.each([
    "agent/../outside",
    "agent/AGENTS.md/nested",
    "agent/agents",
    "data/settings",
    "agent/agents/foo\\..\\..\\outside",
  ])("rejects unsafe path %s before changing settings", (path) => {
    const target = directory();
    const targetAgent = join(target, "agent");
    mkdirSync(targetAgent, { recursive: true });
    writeFileSync(join(targetAgent, "AGENTS.md"), "unchanged", "utf8");
    const archive = gzipSync(Buffer.from(JSON.stringify({
      format: "leafcode-pi-profile",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      files: { [path]: Buffer.from("bad").toString("base64") },
    })));

    expect(() => importProfile(archive, { agentDir: targetAgent, leafcodeDir: join(target, "data") })).toThrow("許可されないパス");
    expect(readFileSync(join(targetAgent, "AGENTS.md"), "utf8")).toBe("unchanged");
  });
});
