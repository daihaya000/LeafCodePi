import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockRequested = vi.hoisted(() => vi.fn());
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => process.env.CLAUDE_CONFIG_DIR ?? actual.tmpdir() };
});
vi.mock("@/lib/codexbar/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/codexbar/utils")>();
  return {
    ...actual,
    fetchText: vi.fn(),
    withRefreshFileLock: vi.fn((path: string, run: () => Promise<unknown>) => {
      lockRequested();
      return actual.withRefreshFileLock(path, run);
    }),
  };
});

import { fetchText } from "@/lib/codexbar/utils";
import { createAnthropicProvider } from "./anthropic";

let dir: string;
let path: string;
const scope = { key: "default", kind: "default" as const, accountId: null, accountLabel: null, authPath: null };
const tokenUrl = "https://console.anthropic.com/v1/oauth/token";

function store(accessToken: string, refreshToken: string, expiresAt: number) {
  writeFileSync(path, JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt, subscriptionType: "pro" },
    untouched: "sentinel",
  }), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anthropic-reread-"));
  path = join(dir, ".credentials.json");
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "empty-pi"));
  vi.mocked(fetchText).mockReset();
  lockRequested.mockReset();
  vi.mocked(fetchText).mockImplementation(async (url, init) => {
    if (url === tokenUrl) {
      return { ok: true, status: 200, body: JSON.stringify({ access_token: "final-access-fixture", refresh_token: "final-refresh-fixture", expires_in: 3600 }) };
    }
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    if (new Headers(init?.headers).get("Authorization") === "Bearer old-access-fixture") {
      return { ok: false, status: 401, body: "unauthorized" };
    }
    return { ok: true, status: 200, body: JSON.stringify({ five_hour: { utilization: 10 } }) };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function refreshTokensSent(): unknown[] {
  return vi.mocked(fetchText).mock.calls.filter(([url]) => url === tokenUrl)
    .map(([, init]) => JSON.parse(String(init?.body)).refresh_token);
}

describe("Anthropic credentials reread after locking", () => {
  it.each(["renewed", "expired", "refresh-only", "deleted"] as const)("handles credentials %s by another lock holder", async (change) => {
    store("old-access-fixture", "old-refresh-fixture", Date.now() + (change === "refresh-only" ? 3600_000 : -1000));
    const actual = await vi.importActual<typeof import("@/lib/codexbar/utils")>("@/lib/codexbar/utils");
    let releaseHolder!: () => void;
    const holder = actual.withRefreshFileLock(path, () => new Promise<void>((resolve) => { releaseHolder = resolve; }));
    const requested = new Promise<void>((resolve) => { lockRequested.mockImplementationOnce(resolve); });
    const fetch = createAnthropicProvider(scope).fetch();
    try {
      await requested; // The provider already read the old credentials and is waiting for the real lock.
      expect(existsSync(`${path}.leafcode-refresh.lock`)).toBe(true);
      if (change === "deleted") unlinkSync(path);
      else store(change === "refresh-only" ? "old-access-fixture" : "other-access-fixture", "other-refresh-fixture", Date.now() + (change === "expired" ? -1000 : 3600_000));
      releaseHolder();
      await holder;

      if (change === "deleted") {
        await expect(fetch).rejects.toThrow("OAuth");
        expect(refreshTokensSent()).toEqual([]);
        expect(existsSync(path)).toBe(false);
      } else {
        expect((await fetch).windows[0]?.usedPercent).toBe(10);
        expect(refreshTokensSent()).toEqual(change === "renewed" ? [] : ["other-refresh-fixture"]);
        const stored = JSON.parse(readFileSync(path, "utf8"));
        expect(stored.untouched).toBe("sentinel");
        expect(stored.claudeAiOauth.accessToken).toBe(change === "renewed" ? "other-access-fixture" : "final-access-fixture");
        const usageCalls = vi.mocked(fetchText).mock.calls.filter(([url]) => url !== tokenUrl);
        expect(new Headers(usageCalls.at(-1)?.[1]?.headers).get("Authorization")).toBe(`Bearer ${stored.claudeAiOauth.accessToken}`);
      }
      expect(existsSync(`${path}.leafcode-refresh.lock`)).toBe(false);
    } finally {
      releaseHolder();
      await holder;
      await fetch.catch(() => undefined);
    }
  });

  it.each(["expired", "unauthorized"] as const)("still refreshes unchanged %s credentials", async (reason) => {
    store("old-access-fixture", "old-refresh-fixture", Date.now() + (reason === "expired" ? -1000 : 3600_000));
    expect((await createAnthropicProvider(scope).fetch()).windows[0]?.usedPercent).toBe(10);
    expect(refreshTokensSent()).toEqual(["old-refresh-fixture"]);
    expect(JSON.parse(readFileSync(path, "utf8")).claudeAiOauth.refreshToken).toBe("final-refresh-fixture");
    expect(existsSync(`${path}.leafcode-refresh.lock`)).toBe(false);
  });
});
