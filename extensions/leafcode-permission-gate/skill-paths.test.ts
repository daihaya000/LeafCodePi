import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerSkillPaths, { bundledSkillPaths, resolveSkillReadPath, SKILL_PATH_GUIDANCE } from "./skill-paths.ts";
import { buildSkillInjection, clearSkillCache, resolveSkills } from "../leafcode-subagents/src/agents/skills.ts";

// Exercise the installed SDK read tool, not a substitute filesystem reader.
const sdk = await import(new URL("../../web/node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href);
let root = "";
let filePath = "";
let alias = "";
const handlers = new Map<string, (event: never, ctx: never) => unknown>();
const name = "bundled-path-test";

function emit(event: string, input: unknown): unknown {
  return handlers.get(event)?.(input as never, { cwd: root } as never);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-skill-paths-"));
  filePath = join(root, "repository & 日本語", "skills", name, "SKILL.md");
  alias = join(root, "agent", "skills", name, "SKILL.md");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `---\nname: ${name}\ndescription: Test procedure\n---\n手順\n`, "utf8");
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", root);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("LEAFCODE_PI_SKILLS_DIR", resolve(filePath, "../.."));
  vi.stubEnv("LEAFCODE_PI_EXTENSIONS_DIR", join(root, "absent"));
  handlers.clear();
  const api = { on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler) } as unknown as Parameters<typeof registerSkillPaths>[0];
  handlers.set("tool_call", registerSkillPaths(api));
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearSkillCache();
  rmSync(root, { recursive: true, force: true });
});

describe("skill path runtime", () => {
  it("loads through the mandatory permission gate and checks corrected paths", async () => {
    const loader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: sdk.SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
      additionalSkillPaths: bundledSkillPaths(),
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(1);
    expect(loader.getExtensions().extensions[0].handlers.has("tool_call")).toBe(true);
    expect(loader.getSkills().skills.map((skill: { filePath: string }) => skill.filePath)).toEqual([filePath]);

    const runtime = loader.getExtensions().extensions[0];
    const protectedPath = join(root, ".ssh", "SKILL.md");
    mkdirSync(dirname(protectedPath));
    writeFileSync(protectedPath, `---\nname: ${name}\ndescription: Protected procedure\n---\n`, "utf8");
    const systemPrompt = sdk.formatSkillsForPrompt(sdk.loadSkillsFromDir({ dir: dirname(protectedPath), source: "test" }).skills);
    for (const handler of runtime.handlers.get("before_agent_start") ?? []) {
      await handler({ systemPrompt }, { cwd: root });
    }
    const input = { path: alias };
    const result = await runtime.handlers.get("tool_call")[0](
      { toolName: "read", toolCallId: "protected", input }, { cwd: root, hasUI: false },
    );
    expect(input.path).toBe(protectedPath);
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining(".ssh/") });
  });

  it.each(["main", "configured-child"])("repairs a missing global path using the %s inventory and keeps read ranges", async (kind) => {
    const tool = sdk.createReadTool(root);
    await expect(tool.execute("before", { path: alias, limit: 1 })).rejects.toThrow("ENOENT");
    const prompt = kind === "main"
      ? sdk.formatSkillsForPrompt(sdk.loadSkillsFromDir({ dir: dirname(filePath), source: "bundled" }).skills)
      : buildSkillInjection(resolveSkills([name], root).resolved);
    const guidance = emit("before_agent_start", { systemPrompt: prompt });
    expect(JSON.stringify(guidance ?? prompt)).toContain(SKILL_PATH_GUIDANCE);
    const input = { path: alias, offset: 5, limit: 1 };
    emit("tool_call", { toolName: "read", toolCallId: "read-skill", input });
    expect(input).toEqual({ path: filePath, offset: 5, limit: 1 });
    const result = await tool.execute("read-skill", input);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("手順") }]);
    const annotated = emit("tool_result", { toolName: "read", toolCallId: "read-skill", input, ...result, isError: false });
    expect(annotated).toEqual({ content: [{ type: "text", text: expect.stringContaining(dirname(filePath)) }, ...result.content] });
  });

  it("does not redirect existing files, unlisted or ambiguous skills, ordinary files, or writes", () => {
    const skills = [{ name, path: filePath }];
    expect(resolveSkillReadPath(alias, root, [])).toBeUndefined();
    expect(resolveSkillReadPath(alias, root, [...skills, { name, path: join(root, "other", "SKILL.md") }])).toBeUndefined();
    expect(resolveSkillReadPath(join(root, "other", name, "SKILL.md"), root, skills)).toBeUndefined();
    expect(resolveSkillReadPath(join(dirname(alias), "references", "guide.md"), root, skills)).toBeUndefined();
    expect(resolveSkillReadPath(join(dirname(alias), "..", "..", "secret", "SKILL.md"), root, skills)).toBeUndefined();
    const prompt = sdk.formatSkillsForPrompt(sdk.loadSkillsFromDir({ dir: dirname(filePath), source: "bundled" }).skills);
    emit("before_agent_start", { systemPrompt: prompt });
    const input = { path: alias, content: "unchanged" };
    emit("tool_call", { toolName: "write", toolCallId: "write", input });
    expect(input.path).toBe(alias);
    mkdirSync(dirname(alias), { recursive: true });
    writeFileSync(alias, "user skill", "utf8");
    expect(resolveSkillReadPath(alias, root, skills)).toBeUndefined();
  });

  it("drops disabled skills when the prompt inventory changes", () => {
    const prompt = sdk.formatSkillsForPrompt(sdk.loadSkillsFromDir({ dir: dirname(filePath), source: "bundled" }).skills);
    emit("before_agent_start", { systemPrompt: prompt });
    expect(emit("before_agent_start", { systemPrompt: "Skills disabled." })).toBeUndefined();
    const input = { path: alias };
    emit("tool_call", { toolName: "read", toolCallId: "disabled", input });
    expect(input.path).toBe(alias);
  });

  it("accepts home aliases without looking for a global skill copy", () => {
    const skills = [{ name, path: filePath }];
    expect(resolveSkillReadPath(`~/.pi/agent/skills/${name}/SKILL.md`, root, skills)).toBe(filePath);
    expect(resolveSkillReadPath(join(homedir(), ".agents", "skills", name, "SKILL.md"), root, skills)).toBe(filePath);
  });
});

it("uses explicit roots independently of cwd, and resolves repository defaults from its own module", () => {
  expect(bundledSkillPaths()).toEqual([resolve(filePath, "../..")]);
  vi.stubEnv("LEAFCODE_PI_SKILLS_DIR", "");
  vi.stubEnv("LEAFCODE_PI_EXTENSIONS_DIR", "");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  expect(bundledSkillPaths()).toContain(join(repo, "skills"));
  expect(bundledSkillPaths()).toContain(join(repo, "extensions", "leafcode-subagents", "skills"));
});
