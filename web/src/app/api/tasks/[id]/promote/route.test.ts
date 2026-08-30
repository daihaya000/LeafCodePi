import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  promoteTask: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { POST } from "./route";

describe("POST /api/tasks/[id]/promote", () => {
  beforeEach(() => {
    mocks.promoteTask.mockReset();
  });

  it("passes the selected destination to the promotion service", async () => {
    const result = { task: { id: "task-1" }, project: { id: "project-1" } };
    mocks.promoteTask.mockResolvedValue(result);

    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/promote", {
        method: "POST",
        body: JSON.stringify({ destinationPath: "C:\\work\\project" }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.promoteTask).toHaveBeenCalledWith("task-1", "C:\\work\\project");
    expect(await response.json()).toEqual(result);
  });

  it("rejects an empty destination", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/promote", {
        method: "POST",
        body: JSON.stringify({ destinationPath: "  " }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.promoteTask).not.toHaveBeenCalled();
  });
});
