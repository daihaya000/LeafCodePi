import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withBotCodeSessionLock } from "./bot-code-session-lock";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable Bot Code session lock", () => {
  it("serializes concurrent callers through an on-disk lock", async () => {
    const dir = join(tmpdir(), `leafcode-lock-${Date.now()}-${Math.random()}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const order: string[] = [];
    const first = withBotCodeSessionLock("bot-1", async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 45));
      order.push("first-end");
    }, { retryMs: 2 });
    const second = withBotCodeSessionLock("bot-1", async () => {
      order.push("second");
    }, { retryMs: 2 });
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});