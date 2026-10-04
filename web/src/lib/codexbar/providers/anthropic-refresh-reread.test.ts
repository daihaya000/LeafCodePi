import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockRequested = vi.hoisted(() => vi.fn());
const atomicWrite = vi.hoisted(() => vi.fn());
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => process.env.CLAUDE_CONFIG_DIR ?? actual.tmpdir() };
});
vi.mock("@/lib/codexbar/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/codexbar/utils")>();
  atomicWrite.mockImplementation(actual.atomicWriteText);
  return {
    ...actual,
    atomicWriteText: atomicWrite,
    fetchText: vi.fn(),
    withRefreshFileLock: vi.fn((path: string, run: () => Promise<unknown>) => {
      lockRequested();
      return actual.withRefreshFileLock(path, run);
    }),
  };
});

import { fetchText, withRefreshFileLock } from "@/lib/codexbar/utils";
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
  atomicWrite.mockClear();
  vi.mocked(withRefreshFileLock).mockClear();
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
  it("retries the stale refresh token on the next poll when persisting rotated tokens fails", async () => {
    store("old-access-fixture", "old-refresh-fixture", Date.now() + 3600_000);
    atomicWrite.mockImplementationOnce(() => { throw new Error("simulated disk failure"); });
    let tokenRequests = 0;
    vi.mocked(fetchText).mockImplementation(async (url, init) => {
      if (url === tokenUrl) {
        tokenRequests += 1;
        if (tokenRequests > 1) return { ok: false, status: 400, body: "invalid_grant" };
        return { ok: true, status: 200, body: JSON.stringify({ access_token: "final-access-fixture", refresh_token: "final-refresh-fixture", expires_in: 3600 }) };
      }
      expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
      if (new Headers(init?.headers).get("Authorization") === "Bearer old-access-fixture") {
        return { ok: false, status: 401, body: "unauthorized" };
      }
      return { ok: true, status: 200, body: JSON.stringify({ five_hour: { utilization: 10 } }) };
    });
    const provider = createAnthropicProvider(scope);

    expect((await provider.fetch()).windows[0]?.usedPercent).toBe(10);
    await expect(provider.fetch()).rejects.toThrow("OAuth");
    expect(refreshTokensSent()).toEqual(["old-refresh-fixture", "old-refresh-fixture"]);
    expect(JSON.parse(readFileSync(path, "utf8")).claudeAiOauth.refreshToken).toBe("old-refresh-fixture");
    const usageCalls = vi.mocked(fetchText).mock.calls.filter(([url]) => url !== tokenUrl);
    expect(usageCalls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual([
      "Bearer old-access-fixture",
      "Bearer final-access-fixture",
      "Bearer old-access-fixture",
    ]);
  });

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

  it.each(["default", "account"] as const)("serializes Pi refresh and reuses tokens rotated under lock (%s)", async (storeKind) => {
    const piDir = join(dir, "pi-store");
    const piPath = join(piDir, "auth.json");
    mkdirSync(piDir, { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", piDir);
    writeFileSync(piPath, JSON.stringify({
      anthropic: { type: "oauth", access: "old-pi-access-fixture", refresh: "old-pi-refresh-fixture", expires: Date.now() - 1000 },
      untouched: "sentinel",
    }), "utf8");
    const piScope = storeKind === "account"
      ? { key: "account:fixture", kind: "account" as const, accountId: "fixture", accountLabel: null, authPath: piPath }
      : scope;

    let signalEvent!: (event: "lock" | "refresh" | "usage") => void;
    const event = new Promise<"lock" | "refresh" | "usage">((resolve) => { signalEvent = resolve; });
    lockRequested.mockImplementationOnce(() => signalEvent("lock"));
    vi.mocked(fetchText).mockImplementation(async (url, init) => {
      if (url === tokenUrl) {
        signalEvent("refresh");
        return { ok: true, status: 200, body: JSON.stringify({ access_token: "final-pi-access-fixture", refresh_token: "final-pi-refresh-fixture", expires_in: 3600 }) };
      }
      signalEvent("usage");
      expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer other-pi-access-fixture");
      return { ok: true, status: 200, body: JSON.stringify({ five_hour: { utilization: 10 } }) };
    });

    const actual = await vi.importActual<typeof import("@/lib/codexbar/utils")>("@/lib/codexbar/utils");
    let releaseHolder!: () => void;
    const holder = actual.withRefreshFileLock(piPath, () => new Promise<void>((resolve) => { releaseHolder = resolve; }));
    const provider = createAnthropicProvider(piScope);
    const fetches = Promise.all([provider.fetch(), provider.fetch()]);
    try {
      expect(await event).toBe("lock");
      expect(withRefreshFileLock).toHaveBeenCalledOnce();
      expect(withRefreshFileLock).toHaveBeenCalledWith(piPath, expect.any(Function));
      expect(existsSync(`${piPath}.leafcode-refresh.lock`)).toBe(true);
      writeFileSync(piPath, JSON.stringify({
        anthropic: { type: "oauth", access: "other-pi-access-fixture", refresh: "other-pi-refresh-fixture", expires: Date.now() + 3600_000 },
        untouched: "sentinel",
      }), "utf8");
      releaseHolder();
      await holder;

      expect((await fetches).map((snapshot) => snapshot.windows[0]?.usedPercent)).toEqual([10, 10]);
      expect(refreshTokensSent()).toEqual([]);
      expect(JSON.parse(readFileSync(piPath, "utf8"))).toMatchObject({
        untouched: "sentinel",
        anthropic: { access: "other-pi-access-fixture", refresh: "other-pi-refresh-fixture" },
      });
      expect(existsSync(`${piPath}.leafcode-refresh.lock`)).toBe(false);
    } finally {
      releaseHolder();
      await holder;
      await fetches.catch(() => undefined);
    }
  });

  it("refreshes expired Pi credentials while holding the adjacent refresh lock", async () => {
    const piDir = join(dir, "pi-store");
    const piPath = join(piDir, "auth.json");
    mkdirSync(piDir, { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", piDir);
    writeFileSync(piPath, JSON.stringify({
      anthropic: { type: "oauth", access: "old-pi-access-fixture", refresh: "old-pi-refresh-fixture", expires: Date.now() - 1000 },
      untouched: "sentinel",
    }), "utf8");
    vi.mocked(fetchText).mockImplementation(async (url, init) => {
      if (url === tokenUrl) {
        expect(existsSync(`${piPath}.leafcode-refresh.lock`)).toBe(true);
        expect(JSON.parse(String(init?.body)).refresh_token).toBe("old-pi-refresh-fixture");
        return { ok: true, status: 200, body: JSON.stringify({ access_token: "new-pi-access-fixture", refresh_token: "new-pi-refresh-fixture", expires_in: 3600 }) };
      }
      expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer new-pi-access-fixture");
      return { ok: true, status: 200, body: JSON.stringify({ five_hour: { utilization: 10 } }) };
    });

    expect((await createAnthropicProvider(scope).fetch()).windows[0]?.usedPercent).toBe(10);
    expect(withRefreshFileLock).toHaveBeenCalledOnce();
    expect(withRefreshFileLock).toHaveBeenCalledWith(piPath, expect.any(Function));
    expect(refreshTokensSent()).toEqual(["old-pi-refresh-fixture"]);
    expect(JSON.parse(readFileSync(piPath, "utf8"))).toMatchObject({
      untouched: "sentinel",
      anthropic: { access: "new-pi-access-fixture", refresh: "new-pi-refresh-fixture" },
    });
    expect(existsSync(`${piPath}.leafcode-refresh.lock`)).toBe(false);
  });

  it.each(["expired", "unauthorized"] as const)("still refreshes unchanged %s credentials", async (reason) => {
    store("old-access-fixture", "old-refresh-fixture", Date.now() + (reason === "expired" ? -1000 : 3600_000));
    expect((await createAnthropicProvider(scope).fetch()).windows[0]?.usedPercent).toBe(10);
    expect(refreshTokensSent()).toEqual(["old-refresh-fixture"]);
    expect(JSON.parse(readFileSync(path, "utf8")).claudeAiOauth.refreshToken).toBe("final-refresh-fixture");
    expect(existsSync(`${path}.leafcode-refresh.lock`)).toBe(false);
  });
});
