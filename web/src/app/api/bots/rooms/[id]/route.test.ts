import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ destroyTask: vi.fn() }));
vi.mock("@/lib/pi/harness", () => ({ destroyTask: state.destroyTask }));

import { createBot } from "@/lib/bots";
import { createRoom, ensureRoomBotTask } from "@/lib/rooms";
import { getTask } from "@/lib/store";
import { DELETE } from "./route";

describe("DELETE /api/bots/rooms/[id]", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-api-room-delete-"));
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
  });

  afterEach(() => {
    state.destroyTask.mockReset();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("destroys existing room tasks before deleting the room", async () => {
    const bot = createBot({ name: "Room bot" });
    const room = createRoom({ members: [bot.id] });
    const taskId = ensureRoomBotTask(room, bot);

    const response = await DELETE(new NextRequest("http://localhost", { method: "DELETE" }), {
      params: Promise.resolve({ id: room.id }),
    });

    expect(response.status).toBe(200);
    expect(state.destroyTask).toHaveBeenCalledWith(taskId);
    expect(getTask(taskId)).toBeUndefined();
  });
});
