import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/codexbar/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/codexbar/utils")>();
  return {
    ...actual,
    fetchText: vi.fn(),
    withRefreshFileLock: vi.fn(async (path: string, run: () => Promise<unknown>) => {
      // Fail immediately on single-flight keys instead of waiting 30s for an
      // invalid Windows path. Valid paths still use the real filesystem lock.
      if (!isAbsolute(path)) throw new Error(`Invalid refresh lock path: ${path}`);
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
        expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
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
