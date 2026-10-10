import { BackendTestRequest as Request } from "@/test-request";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const roomApiTestState = vi.hoisted(() => ({ root: "" }));
vi.mock("../../../../lib/paths", async (importOriginal) => { const actual = await importOriginal<typeof import("../../../../lib/paths")>(); return { ...actual, dataDir: () => roomApiTestState.root }; });
import { MAX_ROOM_NAME_CHARS } from "../../../../lib/rooms";
import { GET, POST } from "@backend-runtime/json-business/handlers/bots/rooms/route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/bots/rooms", { method: "POST", body: JSON.stringify(body) });
}

describe("/api/bots/rooms", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "leafcode-api-rooms-")); roomApiTestState.root = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); roomApiTestState.root = ""; });

  it("creates and lists rooms", async () => {
    const response = await POST(request({ name: "Test room" }));
    expect(response.status).toBe(201);
    const created = (await response.json()).room;
    const listed = await GET();
    expect((await listed.json()).rooms[0].id).toBe(created.id);
  });

  it("rejects an oversized name before creating a room", async () => {
    const response = await POST(request({ name: "x".repeat(MAX_ROOM_NAME_CHARS + 1) }));
    expect(response.status).toBe(400);
    const listed = await GET();
    expect((await listed.json()).rooms).toEqual([]);
  });
});
