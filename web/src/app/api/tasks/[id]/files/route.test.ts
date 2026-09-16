import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkspaceListingDto } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getProject: vi.fn(), getTask: vi.fn() }));
vi.mock("@/lib/store", () => mocks);

import { GET } from "./route";

function request(query: string) {
  return new NextRequest(`http://localhost/api/tasks/t1/files${query}`);
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

let taskDirectory = "";
let projectRoot = "";
const tempDirs: string[] = [];

beforeEach(() => {
  mocks.getProject.mockReset();
  mocks.getTask.mockReset();
  taskDirectory = mkdtempSync(join(tmpdir(), "leafcode-task-files-"));
  projectRoot = mkdtempSync(join(tmpdir(), "leafcode-task-project-"));
  tempDirs.push(taskDirectory, projectRoot);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/tasks/[id]/files", () => {
  it("rejects unknown tasks and Bot workspaces", async () => {
    mocks.getTask.mockReturnValue(undefined);
    expect((await GET(request(""), params("t1"))).status).toBe(404);

    mocks.getTask.mockReturnValue({ id: "t1", kind: "bot", projectId: null, directory: taskDirectory });
    const response = await GET(request(""), params("t1"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Botの作業フォルダーは対象外です" });
  });

  it("serves the projectless task workspace", async () => {
    writeFileSync(join(taskDirectory, "notes.md"), "notes\n");
    mocks.getTask.mockReturnValue({ id: "t1", kind: "code", projectId: null, directory: taskDirectory });

    const response = await GET(request(""), params("t1"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as WorkspaceListingDto;
    expect(body.entries).toEqual([
      { name: "notes.md", path: "notes.md", kind: "file", size: 6 },
    ]);
  });

  it("prefers the project root for a project task", async () => {
    writeFileSync(join(projectRoot, "app.ts"), "x\n");
    writeFileSync(join(taskDirectory, "local.ts"), "y\n");
    mocks.getProject.mockReturnValue({ id: "p1", rootPath: projectRoot, archived: false });
    mocks.getTask.mockReturnValue({ id: "t1", kind: "code", projectId: "p1", directory: taskDirectory });

    const response = await GET(request(""), params("t1"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as WorkspaceListingDto;
    expect(body.entries.map((entry) => entry.path)).toEqual(["app.ts"]);
  });
});
