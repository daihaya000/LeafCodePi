import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkspaceFileDto, WorkspaceListingDto } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getProject: vi.fn(), getTask: vi.fn() }));
vi.mock("@/lib/store", () => mocks);

import { GET } from "./route";

function request(query: string) {
  return new NextRequest(`http://localhost/api/projects/p1/files${query}`);
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

let root = "";
const tempDirs: string[] = [];

beforeEach(() => {
  mocks.getProject.mockReset();
  mocks.getTask.mockReset();
  root = mkdtempSync(join(tmpdir(), "leafcode-files-route-"));
  tempDirs.push(root);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/projects/[id]/files", () => {
  it("rejects unknown and archived projects", async () => {
    mocks.getProject.mockReturnValue(undefined);
    expect((await GET(request(""), params("p1"))).status).toBe(404);

    mocks.getProject.mockReturnValue({ id: "p1", rootPath: root, archived: true });
    const archived = await GET(request(""), params("p1"));
    expect(archived.status).toBe(409);
    expect(await archived.json()).toEqual({ error: "アーカイブ済みのプロジェクトです" });
  });

  it("lists entries and serves a file body for read=1", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");
    mocks.getProject.mockReturnValue({ id: "p1", rootPath: root, archived: false });

    const listing = await GET(request("?path=src"), params("p1"));
    expect(listing.status).toBe(200);
    expect(listing.headers.get("cache-control")).toBe("no-store");
    // クライアントは同じ形をそのまま読む（ラッパーを付けない）。
    expect((await listing.json()) as WorkspaceListingDto).toEqual({
      path: "src",
      parent: "",
      truncated: false,
      entries: [{ name: "a.ts", path: "src/a.ts", kind: "file", size: 13 }],
    });

    const file = await GET(request("?path=src%2Fa.ts&read=1"), params("p1"));
    expect(file.status).toBe(200);
    expect((await file.json()) as WorkspaceFileDto).toEqual({
      name: "src/a.ts",
      mimeType: "text/plain",
      size: 13,
      data: Buffer.from("const a = 1;\n", "utf8").toString("base64"),
    });
  });

  it("refuses paths outside the project root", async () => {
    mocks.getProject.mockReturnValue({ id: "p1", rootPath: root, archived: false });
    const response = await GET(request("?path=..%2Foutside&read=1"), params("p1"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "パスが不正です" });
  });
});
