import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeRequest } from "@/lib/pi/bot-code-relay";

const state = vi.hoisted(() => ({ root: "", abortTask: vi.fn(), pendingRoom: vi.fn<(roomId: string) => CodeRequest | undefined>(() => undefined) }));
vi.mock("@/lib/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/paths")>(),
  dataDir: () => state.root,
  storePath: () => join(state.root, "store.json"),
}));
vi.mock("@/lib/pi/harness", () => ({ abortTask: state.abortTask, jsonError: (error: Error) => ({ error: error.message, status: 500 }) }));
vi.mock("@/lib/pi/bot-code-relay", () => ({ pendingRoomCodeRequestForRoom: state.pendingRoom }));

import { createRoom } from "@/lib/rooms";
import { POST } from "./route";

function send(id: string, body: unknown) {
  return POST(new NextRequest("http://localhost", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "leafcode-room-code-"));
  state.abortTask.mockResolvedValue({ id: "code-1", status: "idle" });
});
afterEach(() => {
  rmSync(state.root, { recursive: true, force: true });
  state.abortTask.mockReset();
  state.pendingRoom.mockReset();
});

describe("room Code control", () => {
  it("stops the Room's running Code request", async () => {
    const room = createRoom({ name: "Team" });
    state.pendingRoom.mockReturnValue({ id: "request", codeTaskId: "code-1", room: { id: room.id } } as CodeRequest);
    const result = await send(room.id, { action: "abort" });
    expect(result.status).toBe(200);
    expect(state.abortTask).toHaveBeenCalledWith("code-1");
  });

  it("rejects an unknown room, an unsupported action, and a room with nothing running", async () => {
    const room = createRoom({ name: "Team" });
    expect((await send("missing", { action: "abort" })).status).toBe(404);
    expect((await send(room.id, { action: "start" })).status).toBe(400);
    expect((await send(room.id, { action: "abort" })).status).toBe(404);
    expect(state.abortTask).not.toHaveBeenCalled();
  });
});
