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

vi.mock("@/lib/pi/harness", () => mocks);

import { PATCH } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
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

  it("persists one of the supported project icon colors", async () => {
    mocks.patchProject.mockReturnValue({ id: "project-1", iconColor: "green" });

    const response = await PATCH(new NextRequest("http://localhost/api/projects", {
      method: "PATCH",
      body: JSON.stringify({ id: "project-1", iconColor: "green" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.patchProject).toHaveBeenCalledWith("project-1", { iconColor: "green" });
  });

  it("rejects unsupported project icon colors", async () => {
    const response = await PATCH(new NextRequest("http://localhost/api/projects", {
      method: "PATCH",
      body: JSON.stringify({ id: "project-1", iconColor: "purple" }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.patchProject).not.toHaveBeenCalled();
  });
});
