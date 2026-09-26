import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it, vi } from "vitest";

const { listBrowseDrives } = vi.hoisted(() => ({ listBrowseDrives: vi.fn() }));
vi.mock("@/lib/browse-drives", () => ({ listBrowseDrives }));
vi.mock("@/lib/browse-quick-access", () => ({ buildQuickAccessEntries: () => [] }));
vi.mock("@/lib/browse-paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/browse-paths")>(),
  browseAllowedRoots: () => [],
  oneDriveRoots: () => [],
}));

import { GET } from "./route";

const root = mkdtempSync(join(tmpdir(), "leafcode-drive-route-"));
const drive = join(root, "drive");
const outside = join(root, "outside");
mkdirSync(join(drive, "Projects"), { recursive: true });
mkdirSync(outside);
symlinkSync(outside, join(drive, "escape"), "dir");

afterAll(() => rmSync(root, { recursive: true, force: true }));

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost/api/browse/dirs?path=${encodeURIComponent(path)}`);
}

describe("/api/browse/dirs drives", () => {
  it("exposes discovered drives and permits their folders but not their parent", async () => {
    listBrowseDrives.mockResolvedValue([{ name: "External SSD", path: drive }]);
    const response = await GET(request(drive));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.drives).toEqual([{ name: "External SSD", path: drive }]);
    expect(body.entries).toContainEqual({ name: "Projects", path: join(drive, "Projects") });
    expect(body.parent).toBeNull();
    expect((await GET(request(outside))).status).toBe(403);
    expect((await GET(request(join(drive, "escape")))).status).toBe(403);
  });
});
