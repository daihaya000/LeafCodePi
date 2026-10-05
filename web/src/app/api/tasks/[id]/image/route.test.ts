import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getProject: vi.fn(), getTask: vi.fn(), listProjects: vi.fn() }));
vi.mock("@/lib/store", () => mocks);

import { GET } from "./route";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
let workspace = "";
const tempDirs: string[] = [];

function request(path: string) {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return new NextRequest(`http://localhost/api/tasks/task-1/image${query}`);
}

function params(id = "task-1") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "leafcode-task-image-"));
  tempDirs.push(workspace);
  mocks.getProject.mockReset();
  mocks.getTask.mockReset().mockReturnValue({ id: "task-1", kind: "code", projectId: null, directory: workspace });
  mocks.listProjects.mockReset().mockReturnValue([]);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/tasks/[id]/image", () => {
  it("serves a verified image relative to the task workspace", async () => {
    writeFileSync(join(workspace, "render.png"), png);
    const response = await GET(request("render.png"), params());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it("serves verified agent images from the shared temp directory", async () => {
    const tempOutput = mkdtempSync(join(tmpdir(), "leafcode-agent-image-"));
    tempDirs.push(tempOutput);
    writeFileSync(join(tempOutput, "render.png"), png);
    const response = await GET(request(join(tempOutput, "render.png")), params());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it("rejects unknown tasks, unsupported formats, and mismatched file content", async () => {
    mocks.getTask.mockReturnValueOnce(undefined);
    expect((await GET(request("render.png"), params())).status).toBe(404);

    writeFileSync(join(workspace, "vector.svg"), "<svg></svg>");
    expect((await GET(request("vector.svg"), params())).status).toBe(415);

    writeFileSync(join(workspace, "fake.png"), "not an image");
    expect((await GET(request("fake.png"), params())).status).toBe(415);
  });

  it("rejects paths outside the task workspace and UNC paths", async () => {
    expect((await GET(request("/etc/passwd.png"), params())).status).toBe(403);
    expect((await GET(request("\\\\server\\share\\render.png"), params())).status).toBe(400);
    expect((await GET(request("/\\\\server\\share\\render.png"), params())).status).toBe(400);
  });

  it("rejects directories and oversized images", async () => {
    mkdirSync(join(workspace, "folder.png"));
    expect((await GET(request("folder.png"), params())).status).toBe(400);

    // Sparse files exercise the pre-read size check without allocating 32 MiB in the test.
    const largePath = join(workspace, "large.png");
    writeFileSync(largePath, Buffer.alloc(1));
    const { truncateSync } = await import("node:fs");
    truncateSync(largePath, 32 * 1024 * 1024 + 1);
    expect((await GET(request("large.png"), params())).status).toBe(413);
  });
});
