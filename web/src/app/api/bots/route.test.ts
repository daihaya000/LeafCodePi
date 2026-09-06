import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const botApiTestState = vi.hoisted(() => ({ root: "" }));
vi.mock("../../../lib/paths", async (importOriginal) => { const actual = await importOriginal<typeof import("../../../lib/paths")>(); return { ...actual, dataDir: () => botApiTestState.root }; });
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

describe("/api/bots", () => {
  let root = ""; beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-api-bots-")); botApiTestState.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); botApiTestState.root = ""; });
  it("creates and lists bots", async () => {
    const response = await POST(new NextRequest("http://localhost/api/bots", { method: "POST", body: JSON.stringify({ name: "Test bot" }) }));
    expect(response.status).toBe(201); const created = (await response.json()).bot;
    const listed = await GET(); expect((await listed.json()).bots[0].id).toBe(created.id);
  });
});
