import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageScope } from "@backend-runtime/lib/codexbar/types";
const undiciFetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async original => ({ ...(await original<typeof import("undici")>()), fetch: undiciFetch }));
import { accountOpenDesignCookiePath, createOpenDesignUsageProvider, deleteOpenDesignCookie, hasOpenDesignCookie,
  parseOpenDesignCookieInput, parseOpenDesignUsage, saveOpenDesignCookie, validateOpenDesignCookie } from "@backend-runtime/lib/codexbar/providers/opendesign";

const dirs: string[] = [];
function scope(): UsageScope {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-opendesign-usage-")); dirs.push(dir);
  return { key: "account:a", kind: "account", accountId: "a", accountLabel: "A", authPath: join(dir, "auth.json") };
}
const quota = { eligible: true, tier: "go", windows: [
  { policyId: "five-hour", limitCredits: "100", remainingCredits: "75", durationSeconds: 18000, resetsAt: "2026-10-11T00:00:00Z" },
  { policyId: "week", limitCredits: "1000", remainingCredits: "250", durationSeconds: 604800, resetsAt: null },
] };
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function mockConsole() {
  undiciFetch.mockImplementation(async (url: string) => url.endsWith("/current") ? response({ workspaceId: "workspace-a" })
    : url.endsWith("/wallet/balance") ? response({ balanceUsd: "12.34" }) : response(quota));
}
afterEach(() => { undiciFetch.mockReset(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("OpenDesign Console usage", () => {
  it("accepts a Cookie header without exposing or changing its value", () => {
    expect(parseOpenDesignCookieInput("Cookie: session=fixture; csrf=a=b")).toBe("session=fixture; csrf=a=b");
  });
  it.each(["", "not-a-cookie", "session=x\r\nAuthorization: leaked", "session=x\u0000", "x".repeat(1_000_001)])("rejects malformed cookie input", input => {
    expect(parseOpenDesignCookieInput(input)).toBeNull();
  });
  it("filters Netscape cookies by exact host, subdomain flag, expiry and API path", () => {
    const cookies = [
      ".open-design.ai\tTRUE\t/\tTRUE\t0\tsession\tparent",
      "amr-api.open-design.ai\tFALSE\t/api\tTRUE\t0\tapi\tvalid",
      "open-design.ai\tFALSE\t/\tTRUE\t0\thostonly\twrong",
      "evil-open-design.ai\tTRUE\t/\tTRUE\t0\tevil\twrong",
      "amr-api.open-design.ai\tFALSE\t/cloud\tTRUE\t0\tpath\twrong",
      "amr-api.open-design.ai\tFALSE\t/\tTRUE\t1\texpired\twrong",
    ].join("\n");
    expect(parseOpenDesignCookieInput(cookies)).toBe("session=parent; api=valid");
  });
  it("preserves decimal USD and derives remaining quota without inventing a credit limit", () => {
    const value = parseOpenDesignUsage({ balanceUsd: "12.34" }, quota);
    expect(value).toMatchObject({ creditsBalance: 12.34, creditsLimit: null, creditsUsed: null, creditsLabel: "USD", plan: "Design Plan go" });
    expect(value.windows).toMatchObject([{ title: "5時間", usedPercent: 25, windowDurationMs: 18000000 }, { title: "7日間", usedPercent: 75 }]);
  });
  it("accepts zero/negative wallets and quota-only accounts", () => {
    expect(parseOpenDesignUsage({ balanceUsd: "0" }, { eligible: false }).creditsBalance).toBe(0);
    expect(parseOpenDesignUsage({ balanceUsd: "-0.05" }, null).creditsBalance).toBe(-0.05);
    expect(parseOpenDesignUsage(null, quota)).toMatchObject({ creditsEnabled: false, creditsBalance: null });
  });
  it("rejects malformed balances and allowances rather than claiming zero usage", () => {
    expect(() => parseOpenDesignUsage({ balanceUsd: "unknown" }, quota)).toThrow();
    expect(() => parseOpenDesignUsage(null, { eligible: false, windows: [] })).toThrow();
    expect(() => parseOpenDesignUsage({ balanceUsd: 10 }, { eligible: true, windows: [{ limitCredits: 0 }] })).toThrow();
    expect(() => parseOpenDesignUsage({ balanceUsd: 10 }, {})).toThrow();
  });
  it("keeps cookie/workspace credentials account-local and never borrows the model API key", async () => {
    const a = scope(), b = scope();
    vi.stubEnv("OPENDESIGN_API_KEY", "global-model-key");
    saveOpenDesignCookie(a.authPath!, "session=account-a", "workspace-a");
    expect(createOpenDesignUsageProvider(a).isConfigured()).toBe(true);
    expect(createOpenDesignUsageProvider(b).isConfigured()).toBe(false);
    await expect(createOpenDesignUsageProvider(b).fetch()).rejects.toThrow("cookie 登録");
    expect(undiciFetch).not.toHaveBeenCalled();
    deleteOpenDesignCookie(a.authPath!);
    expect(hasOpenDesignCookie(a.authPath!)).toBe(false);
    expect(existsSync(accountOpenDesignCookiePath(a.authPath!))).toBe(false);
  });
  it("treats corrupt storage and expired Netscape cookies as unconfigured", () => {
    const a = scope();
    writeFileSync(accountOpenDesignCookiePath(a.authPath!), "not-json");
    expect(hasOpenDesignCookie(a.authPath!)).toBe(false);
    writeFileSync(accountOpenDesignCookiePath(a.authPath!), JSON.stringify({ workspaceId: "workspace-a", cookies: ".open-design.ai\tTRUE\t/\tTRUE\t1\tsession\texpired" }));
    expect(hasOpenDesignCookie(a.authPath!)).toBe(false);
  });
  it("uses the workspaceId from the Cloud URL as the official workspace header", async () => {
    mockConsole();
    const selectedWorkspaceId = "euqvness4ezcm5dzq6xxcj2s";
    await expect(validateOpenDesignCookie("session=account-a", undefined, selectedWorkspaceId)).resolves.toBe(selectedWorkspaceId);
    expect(undiciFetch).toHaveBeenCalledTimes(3);
    expect(undiciFetch.mock.calls[0][0]).toBe("https://amr-api.open-design.ai/api/v1/workspaces/current");
    expect(undiciFetch.mock.calls[0][1].headers).toEqual({ Cookie: "session=account-a", Accept: "application/json", "x-vela-workspace-id": selectedWorkspaceId });
    expect(undiciFetch.mock.calls.slice(1).every(([, init]) => init.headers["x-vela-workspace-id"] === selectedWorkspaceId)).toBe(true);
  });
  it("rejects an invalid explicitly selected workspace before any request", async () => {
    await expect(validateOpenDesignCookie("session=account-a", undefined, "../other")).rejects.toThrow("workspaceId");
    expect(undiciFetch).not.toHaveBeenCalled();
  });
  it("validates before saving and then fetches only the pinned workspace", async () => {
    mockConsole(); const a = scope();
    const id = await validateOpenDesignCookie("session=account-a");
    expect(id).toBe("workspace-a");
    saveOpenDesignCookie(a.authPath!, "session=account-a", id);
    undiciFetch.mockClear();
    expect((await createOpenDesignUsageProvider(a).fetch()).creditsBalance).toBe(12.34);
    expect(undiciFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of undiciFetch.mock.calls) {
      expect(url).toContain("https://amr-api.open-design.ai/api/v1/workspaces/workspace-a/");
      expect(init.headers).toEqual({ Cookie: "session=account-a", Accept: "application/json", "x-vela-workspace-id": "workspace-a" });
      expect(init.redirect).toBe("error");
    }
    expect(readFileSync(accountOpenDesignCookiePath(a.authPath!), "utf8")).not.toContain("global-model-key");
  });
  it("handles wallet-only and Design Plan-only memberships", async () => {
    const a = scope(); saveOpenDesignCookie(a.authPath!, "session=a", "workspace-a");
    undiciFetch.mockImplementation(async (url: string) => url.endsWith("/wallet/balance") ? response({ balanceUsd: "5" }) : response({}, 404));
    expect(await createOpenDesignUsageProvider(a).fetch()).toMatchObject({ creditsBalance: 5, windows: [] });
    undiciFetch.mockImplementation(async (url: string) => url.endsWith("/wallet/balance") ? response({}, 403) : response(quota));
    expect(await createOpenDesignUsageProvider(a).fetch()).toMatchObject({ creditsBalance: null, windows: [{ usedPercent: 25 }, { usedPercent: 75 }] });
  });
  it("redacts transport failures which might reflect request credentials", async () => {
    const a = scope(); saveOpenDesignCookie(a.authPath!, "session=private-cookie", "workspace-a");
    undiciFetch.mockRejectedValue(new Error("request Cookie: session=private-cookie"));
    await expect(createOpenDesignUsageProvider(a).fetch()).rejects.toThrow("通信できませんでした");
  });
  it("does not swallow expired-session or rate-limit errors or leak reflected response bodies", async () => {
    const a = scope(); saveOpenDesignCookie(a.authPath!, "session=secret", "workspace-a");
    undiciFetch.mockImplementation(async () => response({ error: "session=secret" }, 401));
    await expect(createOpenDesignUsageProvider(a).fetch()).rejects.toThrow("期限切れ");
    undiciFetch.mockImplementation(async () => response({ error: "session=secret" }, 429));
    await expect(createOpenDesignUsageProvider(a).fetch()).rejects.toMatchObject({ code: "rate_limit" });
    undiciFetch.mockImplementation(async () => response({ error: "session=secret" }, 500));
    await expect(createOpenDesignUsageProvider(a).fetch()).rejects.toThrow("HTTP 500");
  });
});
