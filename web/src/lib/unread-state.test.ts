import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUnreadReadMarkers, markUnreadRead } from "./unread-state";

const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;

describe("unread state persistence", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "leafcode-unread-state-"));
    process.env.LEAFCODE_PI_DATA_DIR = root;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("persists the newest marker for each Bot, Room, and task", () => {
    expect(markUnreadRead("bot", "bot-1", 100)).toBe(100);
    expect(markUnreadRead("room", "room-1", 200)).toBe(200);
    expect(markUnreadRead("task", "task-1", 300)).toBe(300);
    expect(markUnreadRead("bot", "bot-1", 50)).toBe(100);

    expect(getUnreadReadMarkers()).toEqual(expect.arrayContaining([
      { kind: "bot", id: "bot-1", readAt: 100 },
      { kind: "room", id: "room-1", readAt: 200 },
      { kind: "task", id: "task-1", readAt: 300 },
    ]));
    expect(JSON.parse(readFileSync(join(root, "web-settings.json"), "utf8"))["unread-last-read"]).toContain("bot-1");
  });

  it("rejects malformed markers without writing", () => {
    expect(markUnreadRead("unknown", "id", 1)).toBeNull();
    expect(markUnreadRead("bot", "", 1)).toBeNull();
    expect(markUnreadRead("bot", "id", 0)).toBeNull();
    expect(getUnreadReadMarkers()).toEqual([]);
  });
});
