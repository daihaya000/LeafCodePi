import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __withRefreshLockForTests } from "./anthropic";
import { withRefreshFileLock } from "../utils";

let dir = "";
let credentials: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anthropic-refresh-lock-"));
  credentials = join(dir, ".credentials.json");
  writeFileSync(credentials, "{}", "utf8");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("cross-process refresh lock", () => {
  it("holds the lock for the duration of the refresh and releases it afterwards", async () => {
    const lockPath = `${credentials}.leafcode-refresh.lock`;
    let sawLockInside = false;
    await __withRefreshLockForTests(credentials, async () => {
      sawLockInside = existsSync(lockPath);
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
    });
    expect(sawLockInside).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("serializes a second holder that waits for the first to finish", async () => {
    const order: string[] = [];
    const first = __withRefreshLockForTests(credentials, async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
    });
    const second = __withRefreshLockForTests(credentials, async () => {
      order.push("second-start");
    });
    await Promise.all([first, second]);
    // The two refreshes must not overlap: the IdP rotates the refresh token.
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("fails closed instead of refreshing unlocked when an active lock exceeds the wait bound", async () => {
    const lockPath = `${credentials}.leafcode-refresh.lock`;
    let releaseHolder!: () => void;
    const holder = withRefreshFileLock(credentials, () => new Promise<void>((resolve) => { releaseHolder = resolve; }));
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lockPath, stale, stale);
    vi.useFakeTimers();
    const run = vi.fn(async () => "refreshed");
    const pending = withRefreshFileLock(credentials, run);
    const rejection = expect(pending).rejects.toThrow("Timed out waiting for OAuth refresh lock");

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(run).not.toHaveBeenCalled();
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      releaseHolder();
      await holder;
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a stale lock when its live PID belongs to a newer process", async () => {
    const lockPath = `${credentials}.leafcode-refresh.lock`;
    let releaseHolder!: () => void;
    let processKey: string | undefined;
    const holder = withRefreshFileLock(credentials, async () => {
      processKey = (JSON.parse(readFileSync(lockPath, "utf8")) as { processKey?: string }).processKey;
      await new Promise<void>((resolve) => { releaseHolder = resolve; });
    });
    try {
      expect(processKey).toEqual(expect.any(String));
    } finally {
      releaseHolder();
      await holder;
    }

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, processKey: `reused:${processKey}` }), "utf8");
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lockPath, stale, stale);
    let ran = false;
    await __withRefreshLockForTests(credentials, async () => { ran = true; });
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("takes over a lock left behind by a dead process", async () => {
    const lockPath = `${credentials}.leafcode-refresh.lock`;
    writeFileSync(lockPath, "999999", "utf8");
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lockPath, stale, stale);
    let ran = false;
    await __withRefreshLockForTests(credentials, async () => { ran = true; });
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("codex refresh uses the same cross-process lock", () => {
  it("serializes a codex-style auth file the same way", async () => {
    // This covers helper serialization; actual provider path handling is covered
    // by openai-codex-refresh-lock.test.ts.
    const key = `${credentials}.codex-cli`;
    const order: string[] = [];
    const first = withRefreshFileLock(key, async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
    });
    const second = withRefreshFileLock(key, async () => { order.push("second-start"); });
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });
});
