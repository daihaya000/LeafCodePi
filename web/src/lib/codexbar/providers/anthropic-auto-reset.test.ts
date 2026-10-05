import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageScope } from "../types";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), account: vi.fn((): Record<string, unknown> | undefined => ({ enabled: true, providers: ["anthropic"] })),
  peer: vi.fn((): object | null => null),
  session: vi.fn(), invalidate: vi.fn(), clear: vi.fn(), config: vi.fn(() => ({})),
}));
vi.mock("undici", async (original) => ({ ...(await original<typeof import("undici")>()), fetch: mocks.fetch }));
vi.mock("@/lib/accounts", () => ({ getAccount: mocks.account }));
vi.mock("@backend-core/peer-auth-config.mjs", () => ({ readPeerConfig: mocks.peer }));
vi.mock("../browser-cookies", async (original) => ({ ...(await original<typeof import("../browser-cookies")>()), extractAnthropicConsoleSession: mocks.session }));
vi.mock("../cache", () => ({ invalidateCachedUsage: mocks.invalidate }));
vi.mock("../provider-cache", () => ({ clearProviderCache: mocks.clear }));
vi.mock("../codexbar-config", async (original) => ({ ...(await original<typeof import("../codexbar-config")>()), loadCodexBarConfig: mocks.config }));
import { checkClaudeResetCredits } from "./anthropic-auto-reset";

let root: string;
let now: number;
let scope: UsageScope;
const cookie = (name: string, domain = "claude.ai") => ({ name, domain, value: name === "lastActiveOrg" ? "org" : "test-session", path: "/", hostOnly: false, secure: true, expiresAt: null });
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
function grants(overrides: Record<string, unknown> = {}, block: Record<string, unknown> = {}) {
  return response({ cedar_ember: { eligible: true, cooldown_until: null, next_grant_id: "grant", grants: [{ id: "grant", resets_left: 1, resets_total: 2, usable_now: true, use_requires_limit: false, ends_at: new Date(now + 3600_000).toISOString(), ...overrides }], ...block } });
}
const posts = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-auto-reset-"));
  scope = { key: "account:test", kind: "account", accountId: "test", accountLabel: "test", authPath: join(root, "auth.json") };
  now = Date.parse("2026-10-05T00:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.fetch.mockReset();
  mocks.account.mockReset().mockReturnValue({ enabled: true, providers: ["anthropic"] });
  mocks.peer.mockReset().mockReturnValue(null);
  mocks.session.mockReset().mockReturnValue({ sourceLabel: "account-file", cookies: [cookie("sessionKey"), cookie("lastActiveOrg")] });
  mocks.config.mockReset().mockReturnValue({});
  mocks.invalidate.mockClear(); mocks.clear.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("Claude automatic reset grants", () => {
  it("uses account cookies, redeems one expiring grant by default and invalidates usage", async () => {
    mocks.fetch.mockResolvedValueOnce(grants()).mockResolvedValueOnce(response({ result: "reset", grant_id: "grant", resets_left: 0 }));
    expect(await checkClaudeResetCredits(scope)).toBe(true);
    expect(mocks.session).toHaveBeenCalledWith({ authPath: scope.authPath });
    expect(posts()).toHaveLength(1);
    const body = JSON.parse(posts()[0][1].body);
    expect(body).toMatchObject({ program: "cedar_ember", grant_id: "grant" });
    expect(body.request_id).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-a[a-f\d]{3}-[a-f\d]{12}$/);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.clear).toHaveBeenCalledWith("account:test:anthropic");
    expect(JSON.parse(readFileSync(`${scope.authPath}.claude-auto-reset.json`, "utf8"))).toEqual({ lastSuccessAt: now });
    await checkClaudeResetCredits(scope);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { enabled: true, providers: ["anthropic"], anthropicResetAutoConsume: false },
    { enabled: false, providers: ["anthropic"] },
    { enabled: true, providers: ["openai-codex"] },
    undefined,
  ])("skips disabled, paused, unrelated or missing accounts %j", async (account) => {
    mocks.account.mockReturnValue(account);
    expect(await checkClaudeResetCredits(scope)).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("never uses default auth, API-key accounts, peer-owned accounts or Console-only cookies", async () => {
    await checkClaudeResetCredits({ ...scope, kind: "default", accountId: null, authPath: null });
    writeFileSync(scope.authPath!, JSON.stringify({ anthropic: { type: "api_key", env: {} } })); await checkClaudeResetCredits(scope);
    writeFileSync(scope.authPath!, "{}"); mocks.peer.mockReturnValue({}); await checkClaudeResetCredits(scope);
    mocks.peer.mockReturnValue(null); mocks.session.mockReturnValue({ cookies: [cookie("sessionKey", "claude.com"), cookie("lastActiveOrg", "claude.com")] });
    await checkClaudeResetCredits(scope);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([null, "not-a-date", "2026-10-05T01:00:00", "2026-10-04T00:00:00Z", "2026-10-07T00:00:00Z"])("does not spend unknown, malformed, expired or distant expiry %s", async (expiry) => {
    mocks.fetch.mockResolvedValueOnce(grants({ ends_at: expiry }));
    expect(await checkClaudeResetCredits(scope)).toBe(false);
    expect(posts()).toHaveLength(0);
  });

  it.each([
    [{ paused: true }, {}], [{ usable_now: false }, {}], [{ use_requires_limit: true }, { at_limit: false }],
    [{}, { eligible: false }], [{}, { cooldown_until: "2026-10-05T00:30:00Z" }], [{}, { next_grant_id: "other" }],
  ])("respects Claude availability and cooldown %j %j", async (grant, block) => {
    mocks.fetch.mockResolvedValueOnce(grants(grant, block));
    await checkClaudeResetCredits(scope);
    expect(posts()).toHaveLength(0);
  });

  it("rechecks OFF after listing instead of redeeming a newly disabled account", async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      mocks.account.mockReturnValue({ enabled: true, providers: ["anthropic"], anthropicResetAutoConsume: false });
      return grants();
    });
    expect(await checkClaudeResetCredits(scope)).toBe(false);
    expect(posts()).toHaveLength(0);
  });

  it("coalesces overlapping checks and retries failures with the same idempotency UUID", async () => {
    mocks.fetch.mockResolvedValueOnce(grants()).mockResolvedValueOnce(response({ result: "not_limited" }));
    await Promise.all([checkClaudeResetCredits(scope), checkClaudeResetCredits(scope)]);
    expect(posts()).toHaveLength(1);
    mocks.fetch.mockResolvedValueOnce(grants()).mockResolvedValueOnce(response({ result: "reset", grant_id: "grant" }));
    expect(await checkClaudeResetCredits(scope)).toBe(true);
    expect(JSON.parse(posts()[0][1].body).request_id).toBe(JSON.parse(posts()[1][1].body).request_id);
  });

  it.each(["decreased", "next-grant"])("does not spend another use after a lost POST response and %s state", async (change) => {
    mocks.fetch.mockResolvedValueOnce(grants({ resets_left: 2 })).mockRejectedValueOnce(new Error("lost response"));
    await expect(checkClaudeResetCredits(scope)).rejects.toThrow();
    const saved = JSON.parse(readFileSync(`${scope.authPath}.claude-auto-reset.json`, "utf8"));
    expect(saved.pending).toMatchObject({ grantId: "grant", resetsLeft: 2 });
    expect(saved.pending.requestId).toBe(JSON.parse(posts()[0][1].body).request_id);
    vi.resetModules();
    const restarted = await import("./anthropic-auto-reset");
    mocks.fetch.mockResolvedValueOnce(change === "decreased"
      ? grants({ resets_left: 1 })
      : grants({ id: "next" }, { next_grant_id: "next" }));
    expect(await restarted.checkClaudeResetCredits(scope)).toBe(false);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(readFileSync(`${scope.authPath}.claude-auto-reset.json`, "utf8"))).toEqual({ lastSuccessAt: now });
  });

  it("persists the attempt before POST and retains its UUID across restart when consumption is unconfirmed", async () => {
    mocks.fetch.mockResolvedValueOnce(grants({ resets_left: 2 })).mockImplementationOnce(async (_url, init) => {
      const saved = JSON.parse(readFileSync(`${scope.authPath}.claude-auto-reset.json`, "utf8"));
      expect(saved.pending.requestId).toBe(JSON.parse(init.body).request_id);
      throw new Error("lost response");
    });
    await expect(checkClaudeResetCredits(scope)).rejects.toThrow();
    vi.resetModules();
    const restarted = await import("./anthropic-auto-reset");
    mocks.fetch.mockResolvedValueOnce(grants({ resets_left: 2 })).mockResolvedValueOnce(response({ result: "reset", grant_id: "grant" }));
    expect(await restarted.checkClaudeResetCredits(scope)).toBe(true);
    expect(JSON.parse(posts()[1][1].body).request_id).toBe(JSON.parse(posts()[0][1].body).request_id);
  });

  it("fails closed when the durable journal cannot be written or read", async () => {
    const utils = await import("../utils");
    const current = await import("./anthropic-auto-reset");
    const write = vi.spyOn(utils, "atomicWriteText").mockImplementation(() => { throw new Error("write failed"); });
    mocks.fetch.mockResolvedValueOnce(grants());
    await expect(current.checkClaudeResetCredits(scope)).rejects.toThrow("write failed");
    expect(posts()).toHaveLength(0);
    write.mockRestore();
    writeFileSync(`${scope.authPath}.claude-auto-reset.json`, "{broken");
    await expect(current.checkClaudeResetCredits(scope)).rejects.toThrow("Claude reset state unavailable");
    expect(posts()).toHaveLength(0);
  });

  it("clears an expired pending attempt instead of blocking future grants", async () => {
    mocks.fetch.mockResolvedValueOnce(grants()).mockRejectedValueOnce(new Error("lost response"));
    await expect(checkClaudeResetCredits(scope)).rejects.toThrow();
    mocks.fetch.mockResolvedValueOnce(grants({ ends_at: new Date(now - 1).toISOString(), usable_now: false }));
    expect(await checkClaudeResetCredits(scope)).toBe(false);
    expect(JSON.parse(readFileSync(`${scope.authPath}.claude-auto-reset.json`, "utf8"))).toEqual({ lastSuccessAt: 0 });
    mocks.fetch.mockResolvedValueOnce(grants({ id: "next" }, { next_grant_id: "next" })).mockResolvedValueOnce(response({ result: "reset", grant_id: "next" }));
    expect(await checkClaudeResetCredits(scope)).toBe(true);
    expect(posts()).toHaveLength(2);
  });

  it("retries transient listing errors and uses the persistent cross-process success throttle", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("test transient error"));
    await expect(checkClaudeResetCredits(scope)).rejects.toThrow();
    mocks.fetch.mockResolvedValueOnce(grants()).mockResolvedValueOnce(response({ result: "reset" }));
    expect(await checkClaudeResetCredits(scope)).toBe(true);
    const other = { ...scope, authPath: join(root, "another.json") };
    writeFileSync(`${other.authPath}.claude-auto-reset.json`, JSON.stringify({ lastSuccessAt: now }));
    await checkClaudeResetCredits(other);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not share throttling across accounts and differentiates a grant's remaining uses", async () => {
    mocks.fetch.mockResolvedValueOnce(grants({ resets_left: 2 })).mockResolvedValueOnce(response({ result: "reset" }));
    await checkClaudeResetCredits(scope);
    now += 5 * 60_000 + 1;
    mocks.fetch.mockResolvedValueOnce(grants({ resets_left: 1 })).mockResolvedValueOnce(response({ result: "reset" }));
    await checkClaudeResetCredits(scope);
    expect(JSON.parse(posts()[0][1].body).request_id).not.toBe(JSON.parse(posts()[1][1].body).request_id);
    mocks.fetch.mockResolvedValueOnce(grants()).mockResolvedValueOnce(response({ result: "reset" }));
    expect(await checkClaudeResetCredits({ ...scope, accountId: "other", authPath: join(root, "other.json") })).toBe(true);
  });
});
