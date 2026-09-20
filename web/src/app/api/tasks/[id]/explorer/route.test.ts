import { describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  resolveHostControlUrl: vi.fn(() => "http://127.0.0.1:18775"),
}));

vi.mock("@/lib/store", () => ({ getTask: mocks.getTask }));
vi.mock("@/lib/host-control", () => ({ resolveHostControlUrl: mocks.resolveHostControlUrl }));

describe("GET /api/tasks/[id]/explorer", () => {
  it("returns the temporary task workspace and host control URL", async () => {
    mocks.getTask.mockReturnValue({ directory: "C:\\work\\temporary-task" });

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "task-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      controlUrl: "http://127.0.0.1:18775",
      path: "C:\\work\\temporary-task",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects Bot workspaces", async () => {
    mocks.getTask.mockReturnValue({ kind: "bot", directory: "C:\\work\\bot" });

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "bot-task" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Botの作業フォルダーは対象外です" });
  });

  it("returns 404 when the task does not exist", async () => {
    mocks.getTask.mockReturnValue(undefined);

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(response.status).toBe(404);
  });
});
