import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { writeGlobalAgentsMd } from "@/lib/agents-md";
import { createAgent } from "@/lib/agents";
import { setSkillEnabled } from "@/lib/skills";

const live = vi.hoisted(() => ({ reloadLiveSessionsContext: vi.fn(), refreshLiveSessionsForAgentDefinition: vi.fn() }));
vi.mock("@/lib/pi/harness", () => live);
let root: string, agent: string, data: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-definition-owner-")); agent = join(root, "agent"); data = join(root, "data");
  for (const path of [agent, data, join(agent, "skills/review"), join(root, "extensions"), join(root, "skills")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(agent, "skills/review/SKILL.md"), "---\nname: review\ndescription: Fixture review\n---\nReview safely\n");
  for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: agent, LEAFCODE_PI_DATA_DIR: data, LEAFCODE_PI_EXTENSIONS_DIR: join(root, "extensions"), LEAFCODE_PI_SKILLS_DIR: join(root, "skills"),
    LEAFCODE_PI_PROCESS_ROLE: "backend", LEAFCODE_PI_WEBUI_AUTH: "", LEAFCODE_PI_BIND_HOST: "127.0.0.1" })) vi.stubEnv(key, value);
  live.reloadLiveSessionsContext.mockReset().mockResolvedValue({ reloaded: 1, deferred: 0, failed: 0, errors: [] });
  live.refreshLiveSessionsForAgentDefinition.mockReset().mockReturnValue({ refreshed: 1, deferred: 0 });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function action(route: string, method: string, body?: unknown, operationId = randomUUID(), headers: Record<string, string> = {}) {
  return dispatchJsonBusinessRequest({ route, method, url: `http://localhost/api/${route}`, authorized: true, operationId,
    headers: { host: "localhost", ...headers }, ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }) });
}
describe("Backend definition command owner", () => {
  it("checkpoints a save before live reload and preserves saved success after failed application", async () => {
    live.reloadLiveSessionsContext.mockImplementation(async () => {
      const ledger = JSON.parse(readFileSync(join(data, "configuration-command.json"), "utf8"));
      expect(ledger.operations.at(-1)).toMatchObject({ saved: true, saveStatus: "complete", apply: "unknown" });
      throw new Error("PRIVATE PROVIDER ERROR");
    });
    const result = await action("agents-md", "PATCH", { content: "Owner-only prompt 日本語" });
    expect(result.status).toBe(503); expect(result.body).toMatchObject({ mutation: { saved: true, saveStatus: "complete", apply: "failed" } });
    expect(result.body?.mutation).toHaveProperty("revision"); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(readFileSync(join(agent, "AGENTS.md"), "utf8")).toBe("Owner-only prompt 日本語");
  });
  it("owns create, compound overrides, deletion and live refresh with explicit deferred results", async () => {
    const created = await action("agents", "POST", { name: "custom", systemPrompt: "Fixture" });
    expect(created.status).toBe(201); expect(created.body).toMatchObject({ mutation: { saved: true, apply: "applied" } });
    live.reloadLiveSessionsContext.mockResolvedValue({ reloaded: 0, deferred: 1, failed: 0, errors: [] });
    const updated = await action("agents/custom", "PATCH", { model: "openai/fixture", thinking: "high", tools: [] });
    expect(updated.body).toMatchObject({ mutation: { saved: true, apply: "deferred" } });
    expect(live.refreshLiveSessionsForAgentDefinition).toHaveBeenCalledWith("custom");
    const draft = await action("agents/custom", "GET");
    expect(publicJsonBusinessResult("agents/custom", draft)?.body).toMatchObject({ draft: { model: "openai/fixture", thinking: "high", tools: [] } });
    const removed = await action("agents/custom", "DELETE"); expect(removed.body).toMatchObject({ mutation: { saved: true } });
    expect(existsSync(join(agent, "agents/custom.md"))).toBe(false);
  });
  it("records a save with failed/deferred application without publishing reload errors", async () => {
    live.reloadLiveSessionsContext.mockResolvedValue({ reloaded: 0, deferred: 0, failed: 1, errors: ["PRIVATE TOKEN"] });
    const failed = await action("skills/review", "PATCH", { enabled: false, scope: "bot" });
    expect(failed.status).toBe(503); expect(failed.body).toMatchObject({ mutation: { saved: true, apply: "failed" }, reload: { failed: 1, errors: [] } });
    expect(JSON.stringify(failed)).not.toContain("PRIVATE");
    const state = JSON.parse(readFileSync(join(data, "skills-state.json"), "utf8")); expect(state.bot.review).toBe(true); expect(state.code.review).toBeUndefined();
  });
  it("refuses replay, cross-site requests and invalid names before repeating writes or reload", async () => {
    const id = randomUUID(); await action("agents-md", "PATCH", { content: "First" }, id);
    const replay = await action("agents-md", "PATCH", { content: "Second" }, id); expect(replay.status).toBe(409);
    expect(readFileSync(join(agent, "AGENTS.md"), "utf8")).toBe("First"); expect(live.reloadLiveSessionsContext).toHaveBeenCalledOnce();
    const cross = await action("agents-md", "PATCH", { content: "Second" }, randomUUID(), { origin: "https://evil.test" }); expect(cross.status).toBe(403);
    const bad = await action("agents/%2E%2E%2Fescape", "PATCH", { enabled: true }); expect(bad.status).toBe(400);
    expect(existsSync(join(root, "escape.md"))).toBe(false);
  });
  it("keeps optional references not-required and imports only selected prompt files", async () => {
    const reference = await action("workflow-md", "PATCH", { content: "Reference" });
    expect(reference.body).toMatchObject({ mutation: { saved: true, apply: "not-required" } }); expect(live.reloadLiveSessionsContext).not.toHaveBeenCalled();
    const backup = { format: "leafcode-pi-prompts", version: 1, exportedAt: new Date().toISOString(), files: { "AGENTS.md": "Imported", "USER.md": "Unselected" } };
    const imported = await action("prompts/transfer", "POST", { action: "import", backup, selected: ["AGENTS.md"] });
    expect(imported.status).toBe(200); expect(imported.body).toMatchObject({ imported: ["AGENTS.md"], mutation: { saved: true, apply: "applied" } });
    expect(existsSync(join(agent, "USER.md"))).toBe(false);
    const exported = await action("prompts/transfer", "POST", { action: "export" });
    expect(exported.body).toMatchObject({ mutation: { saved: false, apply: "not-required" } });
  });
  it("does not reinterpret escaped name text as a path separator", async () => {
    const skill = "review%2Ffixture"; mkdirSync(join(agent, "skills", skill));
    writeFileSync(join(agent, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Escaped literal\n---\nReview\n`);
    const saved = await action("skills/review%252Ffixture", "PATCH", { enabled: false });
    expect(saved.status).toBe(200); expect(saved.body).toMatchObject({ name: skill, mutation: { saved: true } });
    expect(JSON.parse(readFileSync(join(data, "skills-state.json"), "utf8")).code[skill]).toBe(true);
  });
  it("Next cannot reach common definition writers, including create-before-mkdir and lock paths", () => {
    vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next");
    expect(() => writeGlobalAgentsMd("Forbidden")).toThrow("Configuration is owned by Backend");
    expect(() => createAgent({ name: "forbidden", systemPrompt: "No" })).toThrow("Configuration is owned by Backend");
    expect(() => setSkillEnabled("review", false)).toThrow("Configuration is owned by Backend");
    expect(existsSync(join(agent, "agents"))).toBe(false); expect(readdirSync(data)).toEqual([]);
  });
});
