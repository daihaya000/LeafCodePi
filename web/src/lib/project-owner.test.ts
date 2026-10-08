import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { upsertProject, patchProject, deleteProjectRecord, listProjects } from "@/lib/store";
import { prepareWorkspaceMove } from "@/lib/workspace-move";
import * as lifecycle from "@backend-runtime/lib/project-lifecycle";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-project-owner-")); vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend"); vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data")); vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function request(method: string, body?: unknown, query = "", operationId: string | undefined = method === "GET" ? undefined : randomUUID()) {
  const result = await dispatchJsonBusinessRequest({ route: "projects", method, operationId, url: `http://localhost/api/projects${query}`, headers: { host: "localhost" }, authorized: true, ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }) });
  const projected = publicJsonBusinessResult("projects", result); expect(projected).not.toBeNull(); expect(projected!.body).not.toBeNull(); return { ...projected!, body: projected!.body! };
}
describe("Backend Project lifecycle owner", () => {
  it("persists create/icon/archive/restore/list through the real store and ledger, with a durable duplicate refusal", async () => {
    const workspace = join(root, "workspace"); mkdirSync(workspace); const operationId = randomUUID();
    const created = await request("POST", { rootPath: workspace }, "", operationId); expect(created.status).toBe(200); const id = (created.body.project as { id: string }).id; expect(created.body.operation).toEqual({ id: operationId, execution: "complete" });
    expect((await request("POST", { rootPath: workspace }, "", operationId)).status).toBe(409); expect(listProjects(true)).toHaveLength(1);
    expect((await request("PATCH", { id, iconColor: "purple" })).status).toBe(200); expect((await request("PATCH", { id, icon: "data:image/png;base64,YQ==" })).status).toBe(200);
    const listed = await request("GET"); expect((listed.body.projects as Array<{ icon: string }>)[0].icon).toMatch(/^\/api\/projects\/.+\/icon\?v=/); expect(JSON.stringify(listed)).not.toContain("YQ==");
    expect((await request("PATCH", { id, archived: true })).status).toBe(200); expect((await request("GET")).body.projects).toEqual([]); expect(((await request("GET", undefined, "?archived=1")).body.projects as unknown[])).toHaveLength(1);
    expect((await request("PATCH", { id, archived: false })).status).toBe(200); expect(readFileSync(join(root, "data", "project-command.json"), "utf8")).not.toContain(workspace);
  });
  it("moves a workspace only to an empty valid destination and reports failures without losing the project", async () => {
    const source = join(root, "source"), destination = join(root, "destination"); mkdirSync(source); writeFileSync(join(source, "keep.txt"), "kept"); const project = upsertProject({ name: "source", rootPath: source });
    const moved = await request("PATCH", { id: project.id, destinationPath: destination }); expect(moved.status).toBe(200); expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("kept"); expect(listProjects(true)[0].rootPath).toBe(destination);
    const blocked = join(root, "blocked"); mkdirSync(blocked); writeFileSync(join(blocked, "x"), "x"); const refused = await request("PATCH", { id: project.id, destinationPath: blocked }); expect(refused.status).toBe(400); expect(listProjects(true)[0].rootPath).toBe(destination); expect(readFileSync(join(blocked, "x"), "utf8")).toBe("x");
    expect((await request("PATCH", { id: project.id, destinationPath: "relative" })).status).toBe(400);
  });
  it("deletes only the project's records and rejects invalid IDs without executing", async () => {
    const project = upsertProject({ name: "delete", rootPath: root }); expect((await request("DELETE", undefined, "?id=..%2Fp")).status).toBe(400); expect(listProjects(true)).toHaveLength(1);
    const deleted = await request("DELETE", undefined, `?id=${project.id}`); expect(deleted.status).toBe(200); expect(deleted.body.ok).toBe(true); expect(listProjects(true)).toEqual([]);
    expect((await request("DELETE", undefined, "?id=missing")).status).toBe(404);
  });
  it("Next refuses shared store/move/ledger mutations before filesystem effects", async () => {
    const source = join(root, "source"); mkdirSync(source); const project = upsertProject({ name: "source", rootPath: source }); vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next"); const before = readdirSync(root);
    for (const action of [() => upsertProject({ name: "x", rootPath: root }), () => patchProject(project.id, { archived: true }), () => deleteProjectRecord(project.id), () => lifecycle.archiveProjectAndStopTasks(project.id), () => lifecycle.destroyProject(project.id), () => lifecycle.migrateProject(project.id, join(root, "moved")), () => prepareWorkspaceMove(source, join(root, "moved"))]) { try { const result = action(); if (result instanceof Promise) await expect(result).rejects.toThrow("owned by Backend"); else throw new Error("must reject"); } catch (error) { expect(String(error)).toContain("owned by Backend"); } }
    expect(readdirSync(root)).toEqual(before); vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend"); expect(listProjects(true)[0].archived).toBeFalsy();
  });
});
