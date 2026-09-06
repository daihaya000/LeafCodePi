import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { botCodeSessionLockPath, withBotCodeSessionLock } from "./bot-code-session-lock";

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

  it("does not steal an old lock while its PID is alive", async () => {
    const dir = join(tmpdir(), `leafcode-live-lock-${Date.now()}-${Math.random()}`);
    dirs.push(dir);
    const lockDir = join(dir, "bots", "bot-live");
    mkdirSync(lockDir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    writeFileSync(botCodeSessionLockPath("bot-live"), JSON.stringify({ token: "other", pid: process.pid, acquiredAt: Date.now() - 120_000 }));
    let entered = false;
    await expect(withBotCodeSessionLock("bot-live", async () => { entered = true; }, { retryMs: 1, timeoutMs: 15, staleMs: 10 })).rejects.toMatchObject({ status: 409 });
    expect(entered).toBe(false);
  });

  it("recovers a dead stale lock through the file protocol", async () => {
    const dir = join(tmpdir(), `leafcode-stale-lock-${Date.now()}-${Math.random()}`);
    dirs.push(dir);
    mkdirSync(join(dir, "bots", "bot-dead"), { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    writeFileSync(botCodeSessionLockPath("bot-dead"), JSON.stringify({ token: "dead", pid: 999999, acquiredAt: Date.now() - 120_000 }));
    await expect(withBotCodeSessionLock("bot-dead", async () => "recovered", { retryMs: 1, staleMs: 10 })).resolves.toBe("recovered");
  });
});