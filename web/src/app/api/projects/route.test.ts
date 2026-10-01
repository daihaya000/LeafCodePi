import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addProject: vi.fn(),
  archiveProjectAndStopTasks: vi.fn(),
  destroyProject: vi.fn(),
  getProjects: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  migrateProject: vi.fn(),
  patchProject: vi.fn(),
  restoreProject: vi.fn(),
}));

const owner = vi.hoisted(() => ({
  localRuntimeBlocked: vi.fn(() => false),
  forwardProjectTeardown: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => mocks);
vi.mock("@/lib/pi/runtime-ownership", () => ({ localRuntimeBlocked: owner.localRuntimeBlocked }));
vi.mock("@/lib/backend-forward", () => ({ forwardProjectTeardown: owner.forwardProjectTeardown }));

import { DELETE, PATCH } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  owner.localRuntimeBlocked.mockReturnValue(false);
});

describe("PATCH /api/projects", () => {
  it("passes a selected destination to the project migration service", async () => {
    const result = { project: { id: "project-1", rootPath: "C:\\work\\moved" } };
    mocks.migrateProject.mockResolvedValue(result);

    const response = await PATCH(new NextRequest("http://localhost/api/projects", {
      method: "PATCH",
      body: JSON.stringify({ id: "project-1", destinationPath: "C:\\work\\moved" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.migrateProject).toHaveBeenCalledWith("project-1", "C:\\work\\moved");
    expect(await response.json()).toEqual(result);
  });

  it("rejects an empty migration destination", async () => {
    const response = await PATCH(new NextRequest("http://localhost/api/projects", {
      method: "PATCH",
      body: JSON.stringify({ id: "project-1", destinationPath: "  " }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.migrateProject).not.toHaveBeenCalled();
  });

  it("persists one of the expanded project icon colors", async () => {
    mocks.patchProject.mockReturnValue({ id: "project-1", iconColor: "purple" });

    const response = await PATCH(new NextRequest("http://localhost/api/projects", {
      method: "PATCH",
      body: JSON.stringify({ id: "project-1", iconColor: "purple" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.patchProject).toHaveBeenCalledWith("project-1", { iconColor: "purple" });
  });

  it.each(["image/x-icon", "image/vnd.microsoft.icon"])("persists an ICO project icon (%s)", async (mime) => {
    const icon = `data:${mime};base64,AAABAAEAEBA=`;
    mocks.patchProject.mockReturnValue({ id: "project-1", icon });

    const response = await PATCH(new NextRequest("http://localhost/api/projects", {
      method: "PATCH",
      body: JSON.stringify({ id: "project-1", icon }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.patchProject).toHaveBeenCalledWith("project-1", { icon });
  });

  it("rejects project icons that are not raster images", async () => {
    const response = await PATCH(new NextRequest("http://localhost/api/projects", {
      method: "PATCH",
      body: JSON.stringify({ id: "project-1", icon: "data:image/svg+xml;base64,PHN2Zy8=" }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.patchProject).not.toHaveBeenCalled();
  });

  it("rejects unsupported project icon colors", async () => {
    const response = await PATCH(new NextRequest("http://localhost/api/projects", {
      method: "PATCH",
      body: JSON.stringify({ id: "project-1", iconColor: "magenta" }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.patchProject).not.toHaveBeenCalled();
  });
});

describe("project teardown while the Backend owns the sessions", () => {
  const patch = (body: unknown) => PATCH(new NextRequest("http://localhost/api/projects", {
    method: "PATCH", body: JSON.stringify(body),
  }));

  beforeEach(() => {
    owner.localRuntimeBlocked.mockReturnValue(true);
  });

  it("forwards archive, move and delete and replays the owner's answer", async () => {
    owner.forwardProjectTeardown.mockResolvedValueOnce({ ok: true, status: 200, body: { project: { id: "project-1" } } });
    const archived = await patch({ id: "project-1", archived: true });
    expect(owner.forwardProjectTeardown).toHaveBeenLastCalledWith("project-1", { action: "archive" });
    expect(await archived.json()).toEqual({ project: { id: "project-1" } });

    owner.forwardProjectTeardown.mockResolvedValueOnce({ ok: true, status: 409, body: { error: "移動先が使われています" } });
    const moved = await patch({ id: "project-1", destinationPath: "C:\work\moved" });
    expect(owner.forwardProjectTeardown).toHaveBeenLastCalledWith("project-1", { action: "migrate", destinationPath: "C:\work\moved" });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: "移動先が使われています" });

    owner.forwardProjectTeardown.mockResolvedValueOnce({ ok: true, status: 200, body: { ok: true } });
    const destroyed = await DELETE(new NextRequest("http://localhost/api/projects?id=project-1", { method: "DELETE" }));
    expect(owner.forwardProjectTeardown).toHaveBeenLastCalledWith("project-1", { action: "destroy" });
    expect(await destroyed.json()).toEqual({ ok: true });

    expect(mocks.archiveProjectAndStopTasks).not.toHaveBeenCalled();
    expect(mocks.migrateProject).not.toHaveBeenCalled();
    expect(mocks.destroyProject).not.toHaveBeenCalled();
  });

  it("reports a Backend that cannot answer as 502 and never acts locally", async () => {
    owner.forwardProjectTeardown.mockResolvedValue({ ok: false, reason: "unreachable" });
    const archived = await patch({ id: "project-1", archived: true });
    expect(archived.status).toBe(502);
    const destroyed = await DELETE(new NextRequest("http://localhost/api/projects?id=project-1", { method: "DELETE" }));
    expect(destroyed.status).toBe(502);
    expect(mocks.archiveProjectAndStopTasks).not.toHaveBeenCalled();
    expect(mocks.destroyProject).not.toHaveBeenCalled();
  });
});
