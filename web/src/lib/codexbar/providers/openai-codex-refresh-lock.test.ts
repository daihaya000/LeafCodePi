import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockRequested = vi.hoisted(() => vi.fn());
vi.mock("@/lib/codexbar/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/codexbar/utils")>();
  return {
    ...actual,
    fetchText: vi.fn(),
    withRefreshFileLock: vi.fn(async (path: string, run: () => Promise<unknown>) => {
      // Fail immediately on single-flight keys instead of waiting 30s for an
      // invalid Windows path. Valid paths still use the real filesystem lock.
      if (!isAbsolute(path)) throw new Error(`Invalid refresh lock path: ${path}`);
      lockRequested();
      return actual.withRefreshFileLock(path, run);
    }),
  };
});

import { fetchText, withRefreshFileLock } from "@/lib/codexbar/utils";
import { createOpenaiCodexProvider } from "./openai-codex";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex refresh-path-"));
  vi.stubEnv("CODEX_HOME", join(dir, "cli"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "pi"));
  vi.mocked(fetchText).mockReset();
  vi.mocked(withRefreshFileLock).mockClear();
  lockRequested.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("Codex refresh lock paths", () => {
  it.each(["cli", "pi", "account"] as const)("refreshes %s auth under a real adjacent lock", async (store) => {
    const path = join(dir, store, "auth.json");
    const lockPath = `${path}.leafcode-refresh.lock`;
    mkdirSync(dirname(path), { recursive: true });
    const fixture = store === "cli"
      ? { tokens: { access_token: "old-access-fixture", refresh_token: "old-refresh-fixture" }, untouched: "sentinel" }
      : { "openai-codex": { type: "oauth", access: "old-access-fixture", refresh: "old-refresh-fixture" }, untouched: "sentinel" };
    writeFileSync(path, JSON.stringify(fixture), "utf8");

    let refreshCalls = 0;
    vi.mocked(fetchText).mockImplementation(async (url, init) => {
      if (url === "https://auth.openai.com/oauth/token") {
        refreshCalls += 1;
        expect(existsSync(lockPath)).toBe(true);
        expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
        expect(JSON.parse(String(init?.body)).refresh_token).toBe("old-refresh-fixture");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true, status: 200, body: JSON.stringify({ access_token: "new-access-fixture", refresh_token: "new-refresh-fixture" }) };
      }
      expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
      if (new Headers(init?.headers).get("Authorization") === "Bearer old-access-fixture") {
        return { ok: false, status: 401, body: "unauthorized" };
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer new-access-fixture");
      return { ok: true, status: 200, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 10 } } }) };
    });

    const provider = createOpenaiCodexProvider({
      key: store === "account" ? "account:fixture" : "default",
      kind: store === "account" ? "account" : "default",
      accountId: store === "account" ? "fixture" : null,
      accountLabel: null,
      authPath: store === "account" ? path : null,
    });
    const snapshots = await Promise.all([provider.fetch(), provider.fetch()]);

    expect(snapshots.map((snapshot) => snapshot.windows[0]?.usedPercent)).toEqual([10, 10]);
    expect(refreshCalls).toBe(1); // Existing in-process single-flight remains intact.
    expect(withRefreshFileLock).toHaveBeenCalledOnce();
    expect(withRefreshFileLock).toHaveBeenCalledWith(path, expect.any(Function));
    expect(existsSync(lockPath)).toBe(false);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.untouched).toBe("sentinel");
    expect(store === "cli" ? stored.tokens : stored["openai-codex"]).toMatchObject(store === "cli"
      ? { access_token: "new-access-fixture", refresh_token: "new-refresh-fixture" }
      : { access: "new-access-fixture", refresh: "new-refresh-fixture" });
  });
});

const usageUrl = "https://chatgpt.com/backend-api/wham/usage";
const tokenUrl = "https://auth.openai.com/oauth/token";

type Store = "cli" | "pi" | "account";

function storeCodexAuth(path: string, access: string, refresh: string, store: Store): void {
  writeFileSync(path, JSON.stringify(store === "cli"
    ? { tokens: { access_token: access, refresh_token: refresh }, untouched: "sentinel" }
    : { "openai-codex": { type: "oauth", access, refresh }, untouched: "sentinel" }), "utf8");
}

function refreshTokensSent(): unknown[] {
  return vi.mocked(fetchText).mock.calls
    .filter(([url]) => url === tokenUrl)
    .map(([, init]) => JSON.parse(String(init?.body)).refresh_token);
}

function providerFor(store: Store, path: string) {
  return store === "account"
    ? createOpenaiCodexProvider({ key: "account:fixture", kind: "account", accountId: "fixture", accountLabel: null, authPath: path })
    : createOpenaiCodexProvider({ key: "default", kind: "default", accountId: null, accountLabel: null, authPath: null });
}

function mockUsageAndRefresh(): void {
  vi.mocked(fetchText).mockImplementation(async (url, init) => {
    if (url === tokenUrl) {
      return { ok: true, status: 200, body: JSON.stringify({ access_token: "final-access-fixture", refresh_token: "final-refresh-fixture" }) };
    }
    expect(url).toBe(usageUrl);
    const authorization = new Headers(init?.headers).get("Authorization");
    if (authorization === "Bearer old-access-fixture") return { ok: false, status: 401, body: "unauthorized" };
    return { ok: true, status: 200, body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 10 } } }) };
  });
}

describe("Codex credentials reread after locking", () => {
  it.each(["cli", "pi", "account"] as const)("reuses %s credentials renewed by another lock holder", async (store) => {
    const path = join(dir, store, "auth.json");
    mkdirSync(dirname(path), { recursive: true });
    storeCodexAuth(path, "old-access-fixture", "old-refresh-fixture", store);
    mockUsageAndRefresh();

    const actual = await vi.importActual<typeof import("@/lib/codexbar/utils")>("@/lib/codexbar/utils");
    let releaseHolder!: () => void;
    const holder = actual.withRefreshFileLock(path, () => new Promise<void>((resolve) => { releaseHolder = resolve; }));
    const requested = new Promise<void>((resolve) => { lockRequested.mockImplementationOnce(() => resolve()); });
    const fetchPromise = providerFor(store, path).fetch();
    try {
      await requested; // The provider read the old credentials and is waiting for the real lock.
      expect(existsSync(`${path}.leafcode-refresh.lock`)).toBe(true);
      storeCodexAuth(path, "other-access-fixture", "other-refresh-fixture", store);
      releaseHolder();
      await holder;

      expect((await fetchPromise).windows[0]?.usedPercent).toBe(10);
      expect(refreshTokensSent()).toEqual([]);
      expect(JSON.parse(readFileSync(path, "utf8")).untouched).toBe("sentinel");
      expect(existsSync(`${path}.leafcode-refresh.lock`)).toBe(false);
    } finally {
      releaseHolder();
      await holder;
      await fetchPromise.catch(() => undefined);
    }
  });

  it.each(["cli", "pi", "account"] as const)("refreshes with the %s refresh token rotated by another lock holder", async (store) => {
    const path = join(dir, store, "auth.json");
    mkdirSync(dirname(path), { recursive: true });
    storeCodexAuth(path, "old-access-fixture", "old-refresh-fixture", store);
    mockUsageAndRefresh();

    const actual = await vi.importActual<typeof import("@/lib/codexbar/utils")>("@/lib/codexbar/utils");
    let releaseHolder!: () => void;
    const holder = actual.withRefreshFileLock(path, () => new Promise<void>((resolve) => { releaseHolder = resolve; }));
    const requested = new Promise<void>((resolve) => { lockRequested.mockImplementationOnce(() => resolve()); });
    const fetchPromise = providerFor(store, path).fetch();
    try {
      await requested;
      // The other holder rotated only the refresh token; the access token still 401s.
      storeCodexAuth(path, "old-access-fixture", "other-refresh-fixture", store);
      releaseHolder();
      await holder;

      expect((await fetchPromise).windows[0]?.usedPercent).toBe(10);
      expect(refreshTokensSent()).toEqual(["other-refresh-fixture"]);
      const stored = JSON.parse(readFileSync(path, "utf8"));
      expect(store === "cli" ? stored.tokens : stored["openai-codex"]).toMatchObject(store === "cli"
        ? { refresh_token: "final-refresh-fixture" }
        : { refresh: "final-refresh-fixture" });
      expect(existsSync(`${path}.leafcode-refresh.lock`)).toBe(false);
    } finally {
      releaseHolder();
      await holder;
      await fetchPromise.catch(() => undefined);
    }
  });

  it.each(["cli", "pi", "account"] as const)("refuses %s credentials deleted by another lock holder", async (store) => {
    const path = join(dir, store, "auth.json");
    mkdirSync(dirname(path), { recursive: true });
    storeCodexAuth(path, "old-access-fixture", "old-refresh-fixture", store);
    mockUsageAndRefresh();

    const actual = await vi.importActual<typeof import("@/lib/codexbar/utils")>("@/lib/codexbar/utils");
    let releaseHolder!: () => void;
    const holder = actual.withRefreshFileLock(path, () => new Promise<void>((resolve) => { releaseHolder = resolve; }));
    const requested = new Promise<void>((resolve) => { lockRequested.mockImplementationOnce(() => resolve()); });
    const fetchPromise = providerFor(store, path).fetch();
    try {
      await requested;
      unlinkSync(path);
      releaseHolder();
      await holder;

      await expect(fetchPromise).rejects.toThrow("OAuth");
      expect(refreshTokensSent()).toEqual([]);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.leafcode-refresh.lock`)).toBe(false);
    } finally {
      releaseHolder();
      await holder;
      await fetchPromise.catch(() => undefined);
    }
  });
});
