import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { listWorkspaceEntries, readWorkspaceFile, resolveWorkspaceRoot } from "@/lib/project-files";
import { generateDirectText, generateDirectTextWithFallbackResult } from "@/lib/direct-generation";
const mocks = vi.hoisted(() => ({ getProject: vi.fn(), getTask: vi.fn(), listTasks: vi.fn(), getSetting: vi.fn(), gitStatus: vi.fn(), gitDiff: vi.fn(), gitLogGraph: vi.fn(), gitBranchRefs: vi.fn(), completeModelText: vi.fn() }));
vi.mock("@/lib/store", async original => ({ ...(await original<object>()), getProject: mocks.getProject, getTask: mocks.getTask, listTasks: mocks.listTasks }));
vi.mock("@/lib/pi/web-settings", async original => ({ ...(await original<object>()), getSetting: mocks.getSetting }));
vi.mock("@/lib/git", async original => ({ ...(await original<object>()), gitStatus: mocks.gitStatus, gitDiff: mocks.gitDiff, gitLogGraph: mocks.gitLogGraph, gitBranchRefs: mocks.gitBranchRefs }));
vi.mock("@/lib/pi/harness", async original => ({ ...(await original<object>()), completeModelText: mocks.completeModelText, listActiveLlamaAgentModels: () => [] }));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-workspace-owner-"));
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend"); vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data")); vi.stubEnv("APPDATA", join(root, "roaming"));
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getProject.mockReturnValue({ id: "p1", rootPath: root, name: "Fixture", archived: false });
  mocks.getTask.mockReturnValue({ id: "t1", kind: "code", projectId: "p1", directory: root }); mocks.listTasks.mockReturnValue([{ projectId: "p1", status: "idle", title: "Prior task" }]);
  mocks.gitStatus.mockResolvedValue(" M hello.txt"); mocks.gitDiff.mockResolvedValue("+fixture change"); mocks.gitLogGraph.mockResolvedValue({ commits: [] }); mocks.gitBranchRefs.mockResolvedValue({ currentBranch: "main" }); mocks.getSetting.mockReturnValue(null);
  mocks.completeModelText.mockResolvedValue("Add fixture tests");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
async function request(route: string, query = "", body?: unknown, signal?: AbortSignal) {
  const result = await dispatchJsonBusinessRequest({ route, url: `http://localhost/api/${route}${query}`, method: body === undefined ? "GET" : "POST", headers: { host: "localhost" }, authorized: true, signal, ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }) });
  const projected = publicJsonBusinessResult(route, result); expect(projected).not.toBeNull(); return projected!;
}
describe("Backend Workspace owner", () => {
  it("returns raw listing/UTF-8 attachment payload, prefers registered project for a task and rejects unsafe/archived/Bot scope", async () => {
    mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "a.ts"), "Hello\n", "utf8");
    const listing = await request("projects/p1/files", "?path=src"); expect(listing.status).toBe(200); expect(listing.body).toEqual({ path: "src", parent: "", entries: [{ name: "a.ts", path: "src/a.ts", kind: "file", size: 6 }], truncated: false });
    const file = await request("tasks/t1/files", "?path=src%2Fa.ts&read=1"); expect(file.body).toEqual({ name: "src/a.ts", mimeType: "text/plain", size: 6, data: Buffer.from("Hello\n").toString("base64") }); expect(file.headers["cache-control"]).toBe("no-store");
    expect((await request("projects/p1/files", "?path=..%2Fsecret&read=1")).status).toBe(400);
    mocks.getTask.mockReturnValue({ kind: "bot" }); expect((await request("tasks/bot:1/files")).status).toBe(403);
    mocks.getProject.mockReturnValue({ archived: true }); expect((await request("projects/p1/files")).status).toBe(409);
  });
  it("rejects malformed/escaped IDs before lookup and never double-decodes them", async () => {
    for (const route of ["projects/p%252Fone/files", "projects/p%2Fone/files", "projects/../files"]) expect((await request(route)).status).toBe(400);
    expect(mocks.getProject).not.toHaveBeenCalled();
    mocks.getProject.mockReturnValue(undefined); expect((await request("projects/missing/files")).status).toBe(404);
  });
  it("owns real suggestion assembly and direct generation; projects only public model identity", async () => {
    const result = await request("projects/p1/next-task", "", { model: { providerID: "fixture-provider", modelID: "fixture" } }); expect(result.status).toBe(200); expect(result.body).toMatchObject({ suggestion: "Add fixture tests", source: "direct", model: { providerID: "fixture-provider", modelID: "fixture" } });
    const input = mocks.completeModelText.mock.calls[0][0]; expect(input.prompt).toContain("hello.txt"); expect(input.prompt).toContain("Prior task"); expect(input.maxTokens).toBe(96); expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(result.body).not.toHaveProperty("mutation"); expect(result.body).not.toHaveProperty("operation"); expect(readdirSync(root)).toEqual([]);
  });
  it("refuses archived projects/invalid bodies and hides Provider exceptions including 4xx", async () => {
    expect((await request("projects/p1/next-task", "", null)).status).toBe(400);
    mocks.getProject.mockReturnValue({ archived: true }); expect((await request("projects/p1/next-task", "", {})).status).toBe(409); expect(mocks.gitStatus).not.toHaveBeenCalled();
    mocks.getProject.mockReturnValue({ rootPath: root, name: "Fixture" }); mocks.completeModelText.mockRejectedValue(Object.assign(new Error("PRIVATE credential/path"), { status: 401 }));
    const failed = await request("projects/p1/next-task", "", { model: { providerID: "fixture-provider", modelID: "fixture" } }); expect(failed.status).toBeGreaterThanOrEqual(400); expect(JSON.stringify(failed)).not.toContain("PRIVATE");
  });
  it("disconnect cancels actual generation and cannot continue to fallback", async () => {
    const controller = new AbortController(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    mocks.getSetting.mockImplementation((key: string) => key === "generation-fallback-model" ? "fixture-provider::fallback" : null);
    mocks.completeModelText.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => { entered(); signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }); }));
    const pending = request("projects/p1/next-task", "", { model: { providerID: "fixture-provider", modelID: "fixture" } }, controller.signal); await started; controller.abort(); const result = await pending;
    expect(result.status).toBe(408); expect(mocks.completeModelText).toHaveBeenCalledTimes(1);
  });
  it("Next refuses common filesystem/model execution before touching store, filesystem or Provider", async () => {
    vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next");
    for (const action of [() => resolveWorkspaceRoot({ kind: "project", id: "p1" }), () => listWorkspaceEntries(root, ""), () => readWorkspaceFile(root, "missing")]) expect(action).toThrow("owned by Backend");
    await expect(generateDirectText({ model: { providerID: "fixture", modelID: "fixture" }, system: "S", prompt: "P" })).rejects.toThrow("owned by Backend");
    await expect(generateDirectTextWithFallbackResult({ candidates: [], system: "S", prompt: "P" })).rejects.toThrow("owned by Backend");
    expect(mocks.getProject).not.toHaveBeenCalled(); expect(mocks.completeModelText).not.toHaveBeenCalled(); expect(readdirSync(root)).toEqual([]);
  });
});
