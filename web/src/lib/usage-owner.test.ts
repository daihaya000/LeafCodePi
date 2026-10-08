import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { emptyUsage } from "@/lib/codexbar";
import { __resetPiAgentDirCacheForTests, createAccount, patchAccount } from "@/lib/accounts";
import { closeTokenUsageStore } from "@/lib/codexbar/token-usage";
const mocks = vi.hoisted(() => ({ fetchNativeUsage: vi.fn(), withOpenaiCodexWhamAuth: vi.fn(), listCodexResetCredits: vi.fn(), consumeCodexResetCredit: vi.fn(), consumeClaudeResetGrant: vi.fn(), listClaudeResetGrants: vi.fn(), extractAnthropicConsoleSession: vi.fn() }));
vi.mock("@/lib/codexbar/orchestrator", async original => ({ ...(await original<object>()), fetchNativeUsage: mocks.fetchNativeUsage }));
vi.mock("@/lib/codexbar/providers/openai-codex", async original => ({ ...(await original<object>()), withOpenaiCodexWhamAuth: mocks.withOpenaiCodexWhamAuth }));
vi.mock("@/lib/codexbar/providers/openai-codex-reset", async original => ({ ...(await original<object>()), consumeCodexResetCredit: mocks.consumeCodexResetCredit, listCodexResetCredits: mocks.listCodexResetCredits }));
vi.mock("@/lib/codexbar/providers/anthropic-reset", async original => ({ ...(await original<object>()), consumeClaudeResetGrant: mocks.consumeClaudeResetGrant, listClaudeResetGrants: mocks.listClaudeResetGrants }));
vi.mock("@/lib/codexbar/browser-cookies", async original => ({ ...(await original<object>()), extractAnthropicConsoleSession: mocks.extractAnthropicConsoleSession }));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-usage-owner-"));
  for (const [key, value] of Object.entries({ LEAFCODE_PI_DATA_DIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), APPDATA: join(root, "roaming"), LEAFCODE_PI_PROCESS_ROLE: "backend", LEAFCODE_PI_WEBUI_AUTH: "" })) vi.stubEnv(key, value);
  __resetPiAgentDirCacheForTests(); for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.fetchNativeUsage.mockResolvedValue(emptyUsage("No provider"));
  mocks.withOpenaiCodexWhamAuth.mockImplementation(async (accountId: string | null, run: (credentials: unknown) => Promise<unknown>) => ({ result: await run({ accessToken: "PRIVATE-TOKEN" }), session: { leafcodeAccountId: accountId, instanceId: accountId ? `account:${accountId}:openai-codex` : "default:openai-codex", credentials: { token: "PRIVATE" } } }));
  mocks.consumeCodexResetCredit.mockResolvedValue({ ok: true, code: "reset", creditId: "credit", windowsReset: 1 });
  mocks.listCodexResetCredits.mockResolvedValue({ availableCount: 1, credits: [{ id: "credit", title: "Reset", status: "available", expiresAt: null, grantedAt: null, description: null, token: "PRIVATE" }] });
});
afterEach(() => { closeTokenUsageStore(); __resetPiAgentDirCacheForTests(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function request(route: string, method: string, body?: unknown, operationId = randomUUID(), query = "") {
  const result = await dispatchJsonBusinessRequest({ route, method, operationId, url: `http://localhost/api/${route}${query}`, headers: { host: "localhost" }, authorized: true, ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }) });
  const projected = publicJsonBusinessResult(route, result); expect(projected).not.toBeNull(); return projected!;
}
describe("Backend native usage and credit owner", () => {
  it("owns provider catalog/version/enablement and preserves private unrelated config with truthful save receipts", async () => {
    const path = join(root, "roaming", "CodexBar", "config.json"); mkdirSync(join(root, "roaming", "CodexBar"), { recursive: true }); writeFileSync(path, JSON.stringify({ enabledProviders: ["openai-codex", "anthropic"], managementKey: "PRIVATE" }));
    const catalog = await request("codexbar/providers", "GET"); expect(catalog.status).toBe(200); expect(JSON.stringify(catalog)).not.toContain("PRIVATE");
    const version = (catalog.body as { version: string }).version;
    const saved = await request("codexbar/providers", "PUT", { providerId: "anthropic", enabled: false, version });
    expect(saved.status).toBe(200); expect(saved.body).toMatchObject({ mutation: { saved: true, saveStatus: "complete", apply: "not-required" } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ enabledProviders: ["openai-codex"], managementKey: "PRIVATE" });
    const conflict = await request("codexbar/providers", "PUT", { providerId: "anthropic", enabled: true, version }); expect(conflict.status).toBe(409); expect(conflict.body).toMatchObject({ mutation: { saved: false } });
  });
  it("owner usage carries scope/refresh, keeps stale/credit/telemetry fields and hides raw provider errors", async () => {
    mocks.fetchNativeUsage.mockResolvedValueOnce({ ...emptyUsage("available"), available: true, providers: [{ id: "openai-codex", plan: "Pro", planMonthlyUsd: 20, opencodeId: null, limited: false, maxed: false, usedPercent: 12, resetsAt: null, updatedAt: null, stale: true, usageDisplayOnly: true, resetCreditsAvailable: 1, error: "PRIVATE failure", authPath: "PRIVATE", windows: [{ id: "w", title: "Window", usedPercent: 12, resetsAt: null, windowMinutes: 300, countsTowardLimit: true }], credits: { title: "USD", used: 1, limit: 10, balance: 9 } }] });
    const result = await request("codexbar/usage", "GET", undefined, undefined, "?scope=account&accountId=fixture&refresh=1");
    expect(result.status).toBe(200); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result.body).toMatchObject({ providers: [{ stale: true, usageDisplayOnly: true, resetCreditsAvailable: 1, credits: { balance: 9 }, tokenUsage: { totalTokens: 0 } }] });
    expect(mocks.fetchNativeUsage).toHaveBeenCalledWith({ scope: { kind: "account", accountId: "fixture" }, forceRefresh: true });
    mocks.fetchNativeUsage.mockRejectedValueOnce(new Error("PRIVATE SDK exception")); const unavailable = await request("codexbar/usage", "GET"); expect(unavailable.status).toBe(200); expect(JSON.stringify(unavailable)).not.toContain("PRIVATE");
  });
  it("lists safe credits and persists external admission before exactly one redeem, without a configuration-save claim", async () => {
    const listed = await request("codexbar/reset-credits", "GET"); expect(listed.status).toBe(200); expect(JSON.stringify(listed)).not.toContain("PRIVATE");
    const operationId = randomUUID();
    mocks.consumeCodexResetCredit.mockImplementationOnce(async (_credentials, input) => {
      expect(JSON.parse(readFileSync(join(root, "usage-command.json"), "utf8")).operations).toEqual([{ id: operationId, execution: "unknown" }]); expect(input.redeemRequestId).toBe(operationId);
      return { ok: true, code: "reset", creditId: "credit", windowsReset: 1 };
    });
    const result = await request("codexbar/reset-credits", "POST", { creditId: "credit" }, operationId);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ ok: true, operation: { id: operationId, execution: "complete" } }); expect(result.body!.mutation).toBeUndefined();
    expect((await request("codexbar/reset-credits", "POST", { creditId: "credit" }, operationId)).status).toBe(409); expect(mocks.consumeCodexResetCredit).toHaveBeenCalledOnce(); expect(readFileSync(join(root, "usage-command.json"), "utf8")).not.toContain("PRIVATE");
  });
  it("declined business outcomes are complete-but-not-consumed, while lost provider responses stay unknown and are not retried", async () => {
    mocks.consumeCodexResetCredit.mockResolvedValueOnce({ ok: false, code: "nothing_to_reset", creditId: "credit", windowsReset: null });
    const declined = await request("codexbar/reset-credits", "POST", { creditId: "credit" }); expect(declined.status).toBe(200); expect(declined.body).toMatchObject({ ok: false, operation: { execution: "complete" } });
    mocks.consumeCodexResetCredit.mockRejectedValueOnce(new Error("PRIVATE provider response lost")); const operationId = randomUUID();
    const lost = await request("codexbar/reset-credits", "POST", { creditId: "credit" }, operationId); expect(lost.status).toBe(503); expect(lost.body).toMatchObject({ operation: { execution: "unknown" } }); expect(JSON.stringify(lost)).not.toContain("PRIVATE");
    expect((await request("codexbar/reset-credits", "POST", { creditId: "credit" }, operationId)).status).toBe(409); expect(mocks.consumeCodexResetCredit).toHaveBeenCalledTimes(2);
  });
  it("validates scope, provider/credit/account inputs and paused-account refusal before native calls", async () => {
    for (const query of ["?scope=bad", "?scope=account"]) expect((await request("codexbar/usage", "GET", undefined, undefined, query)).status).toBe(400);
    for (const body of [null, [], {}, { creditId: "c", provider: "bad" }, { creditId: "c", accountId: "../outside" }, { creditId: "c", redeemRequestId: "" }]) expect((await request("codexbar/reset-credits", "POST", body)).status).toBe(400);
    const account = createAccount({ label: "Paused", providers: ["openai-codex"] }); patchAccount(account.id, { enabled: false });
    expect((await request("codexbar/reset-credits", "POST", { creditId: "c", accountId: account.id })).status).toBe(409);
    expect((await request("codexbar/reset-credits", "GET", undefined, undefined, `?accountId=${account.id}`)).status).toBe(409);
    expect(mocks.consumeCodexResetCredit).not.toHaveBeenCalled(); expect(mocks.fetchNativeUsage).not.toHaveBeenCalled();
  });
  it("Claude uses the account-only cookie and the same operation ID as the external grant request", async () => {
    const account = createAccount({ label: "Claude", providers: ["anthropic"] }); mocks.extractAnthropicConsoleSession.mockReturnValueOnce({ token: "PRIVATE" }); mocks.consumeClaudeResetGrant.mockResolvedValueOnce({ ok: true, code: "reset", grantId: "g" });
    const operationId = randomUUID(); const result = await request("codexbar/reset-credits", "POST", { creditId: "g", accountId: account.id, provider: "anthropic" }, operationId);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ ok: true, operation: { id: operationId, execution: "complete" } }); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(mocks.consumeClaudeResetGrant).toHaveBeenCalledWith({ token: "PRIVATE" }, { grantId: "g", requestId: operationId }); expect(mocks.withOpenaiCodexWhamAuth).not.toHaveBeenCalled();
  });
  it("Next refuses provider config writes before lock/directory creation", async () => {
    vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next"); const { PUT } = await import("@backend-runtime/json-business/handlers/codexbar/providers/route");
    const response = await PUT(new Request("http://localhost/api/codexbar/providers", { method: "PUT", body: JSON.stringify({ providerId: "anthropic", enabled: true, version: "missing" }) }));
    expect(response.status).toBe(503); expect(readdirSync(root)).toEqual([]);
  });
});
