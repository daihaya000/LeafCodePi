import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
import { __resetPiAgentDirCacheForTests, accountAuthPath, createAccount, deleteAccount, importAccountRecords, patchAccount, reorderAccounts } from "@/lib/accounts";
import { deleteAccountAnthropicCookieFile, deleteAccountOpenCodeCookieFile, saveAccountAnthropicCookieFile, saveAccountOpenCodeCookieFile } from "@/lib/codexbar/browser-cookies";
import { deleteOllamaCookieFile, saveOllamaCookieFile } from "@/lib/codexbar/providers/ollama-cloud";
import { writeAnthropicCreditBaseline } from "@/lib/codexbar/providers/anthropic";
import { writeOpenRouterAccountConfig } from "@/lib/codexbar/providers/openrouter";
import { writeAccountOpenCodeGoWorkspace } from "@/lib/codexbar/providers/opencode-go";
const cookie = (domain: string) => `# Netscape HTTP Cookie File\n.${domain}\tTRUE\t/\tTRUE\t4102444800\tsessionKey\tPRIVATE-COOKIE\n`;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-account-owner-"));
  for (const [key, value] of Object.entries({ LEAFCODE_PI_DATA_DIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), APPDATA: join(root, "roaming"), LEAFCODE_PI_PROCESS_ROLE: "backend", LEAFCODE_PI_WEBUI_AUTH: "" })) vi.stubEnv(key, value);
  __resetPiAgentDirCacheForTests();
});
afterEach(() => { __resetPiAgentDirCacheForTests(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function request(route: string, method: string, body?: unknown, operationId = randomUUID()) {
  const result = await dispatchJsonBusinessRequest({ route, method, operationId, url: `http://localhost/api/${route}`, headers: { host: "localhost" }, authorized: true,
    ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }) });
  const projected = publicJsonBusinessResult(route, result); expect(projected).not.toBeNull(); return projected!;
}
async function create(providers = ["anthropic", "openrouter", "opencode-go", "ollama-cloud", "openai-codex"]) {
  const result = await request("accounts", "POST", { label: "Fixture", providers });
  expect(result.status).toBe(200); expect(result.body).toMatchObject({ mutation: { saved: true, saveStatus: "complete", apply: "not-required" } });
  return (result.body as { account: { id: string } }).account.id;
}
describe("Backend account and private credential owner", () => {
  it("owns create/list/reorder/update and rejects durable duplicate admission without another account", async () => {
    const operationId = randomUUID(); const first = await request("accounts", "POST", { label: "First", providers: ["openai-codex"] }, operationId);
    const id = (first.body as { account: { id: string } }).account.id; const secondId = await create();
    expect((await request("accounts", "POST", { label: "Replay", providers: ["openai-codex"] }, operationId)).status).toBe(409);
    expect((await request("accounts", "PATCH", { accountOrder: [secondId, id] })).status).toBe(200);
    expect((await request(`accounts/${id}`, "PATCH", { label: "Changed", note: "kept", codexResetAutoConsume: false })).body).toMatchObject({ account: { label: "Changed", note: "kept", codexResetAutoConsume: false } });
    expect((await request(`accounts/${id}`, "PATCH", { enabled: false })).body).toMatchObject({ account: { note: "kept", enabled: false } });
    expect((await request("accounts", "GET")).body).toMatchObject({ accounts: [{ id: secondId }, { id }] });
    expect((await request("accounts", "PATCH", { accountOrder: [id, id] })).body).toMatchObject({ mutation: { saved: false, saveStatus: "none" } });
    expect((await request(`accounts/${id}`, "PATCH", { providers: ["anthropic"] })).status).toBe(400);
  });
  it("saves, reads configured flags and deletes each credential without exposing bytes or key inputs", async () => {
    const id = await create();
    for (const [suffix, body] of [
      ["anthropic-cookie", { cookies: cookie("claude.ai") }], ["ollama-cookie", { cookies: cookie("ollama.com") }],
      ["opencode-go-cookie", { cookies: cookie("opencode.ai"), workspaceId: "workspace-fixture" }],
      ["openrouter-credits", { managementKey: "PRIVATE-KEY" }], ["anthropic-baseline", { baselineUsd: 50 }], ["openrouter-baseline", { baselineUsd: 100 }],
    ] as const) {
      const result = await request(`accounts/${id}/${suffix}`, "POST", body);
      expect(result.status).toBe(200); expect(result.body).toMatchObject({ mutation: { saved: true, saveStatus: "complete" } }); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    }
    const authPath = accountAuthPath(id, join(root, "agent")); mkdirSync(join(root, "agent", "accounts", id), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: "oauth", access: "PRIVATE-TOKEN", refresh: "PRIVATE-REFRESH", expires: Date.now() + 60000 } }));
    const auth = await request(`accounts/${id}/auth-status`, "GET");
    expect(auth.body).toMatchObject({ providers: ["anthropic"], credentialKinds: { anthropic: "oauth" }, peer: false, ollamaCookieConfigured: true, opencodeGoCookieConfigured: true, anthropicCookieConfigured: true, openrouterManagementKeyConfigured: true, anthropicCreditBaseline: 50, openrouterCreditBaseline: 100 });
    expect(JSON.stringify(auth)).not.toContain("PRIVATE");
    expect((await request(`accounts/${id}/opencode-go-cookie`, "GET")).body).toEqual({ workspaceId: "workspace-fixture" });
    for (const suffix of ["anthropic-cookie", "ollama-cookie", "opencode-go-cookie", "openrouter-credits", "anthropic-baseline", "openrouter-baseline"]) expect((await request(`accounts/${id}/${suffix}`, "DELETE")).body).toMatchObject({ ok: true, mutation: { saved: true } });
    expect((await request(`accounts/${id}/auth-status`, "GET")).body).toMatchObject({ ollamaCookieConfigured: false, opencodeGoCookieConfigured: false, anthropicCookieConfigured: false, openrouterManagementKeyConfigured: false, anthropicCreditBaseline: null, openrouterCreditBaseline: null });
    expect(readFileSync(join(root, "configuration-command.json"), "utf8")).not.toContain("PRIVATE");
  });
  it("preserves wrong-provider, input and management-key deletion constraints", async () => {
    const id = await create(["openrouter"]);
    expect((await request(`accounts/${id}/anthropic-cookie`, "POST", { cookies: cookie("claude.ai") })).status).toBe(400);
    for (const body of [{ managementKey: "" }, { managementKey: "PRIVATE\nKEY" }]) expect((await request(`accounts/${id}/openrouter-credits`, "POST", body)).body).toMatchObject({ mutation: { saved: false } });
    for (const baselineUsd of [0, -1, "10", true, 1000001]) expect((await request(`accounts/${id}/openrouter-baseline`, "POST", { baselineUsd })).status).toBe(400);
    await request(`accounts/${id}/openrouter-credits`, "POST", { managementKey: "PRIVATE-KEY" });
    expect((await request(`accounts/${id}`, "DELETE")).status).toBe(409);
    await request(`accounts/${id}/openrouter-credits`, "DELETE");
    expect((await request(`accounts/${id}`, "DELETE")).body).toMatchObject({ ok: true, mutation: { saved: true } });
    expect((await request(`accounts/${id}/auth-status`, "GET")).status).toBe(404);
  });
  it("does not erase an unreadable management key during baseline edits but accepts explicit replacement-key repair", async () => {
    const id = await create(["openrouter"]); const dir = join(root, "agent", "accounts", id); mkdirSync(dir, { recursive: true });
    const path = join(dir, "openrouter.json"); writeFileSync(path, "{");
    const refused = await request(`accounts/${id}/openrouter-baseline`, "POST", { baselineUsd: 10 });
    expect(refused.status).toBe(500); expect(refused.body).toMatchObject({ mutation: { saved: false, saveStatus: "none" } });
    expect(readFileSync(path, "utf8")).toBe("{");
    expect((await request(`accounts/${id}/openrouter-credits`, "POST", { managementKey: "PRIVATE-REPAIR" })).status).toBe(200);
    expect(JSON.parse(readFileSync(path, "utf8")).managementKey).toBe("PRIVATE-REPAIR");
  });
  it("returns truthful partial save when workspace write fails after the cookie save", async () => {
    const id = await create(["opencode-go"]);
    mkdirSync(join(root, "agent", "accounts", id, "opencode-go.json"), { recursive: true });
    const result = await request(`accounts/${id}/opencode-go-cookie`, "POST", { cookies: cookie("opencode.ai"), workspaceId: "fixture" });
    expect(result.status).toBe(500); expect(result.body).toMatchObject({ mutation: { saved: true, saveStatus: "partial", apply: "failed" } });
    expect(JSON.stringify(result)).not.toContain(root); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(existsSync(join(root, "agent", "accounts", id, "opencode-cookies.txt"))).toBe(true);
  });
  it("retains local auth files but removes peer tokens when an idle peer account is deleted", async () => {
    const id = await create(["anthropic"]); const dir = join(root, "agent", "accounts", id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), "{}"); writeFileSync(join(dir, "peer.json"), "PRIVATE-PEER");
    expect((await request(`accounts/${id}`, "DELETE")).status).toBe(200);
    expect(existsSync(join(dir, "peer.json"))).toBe(false); expect(existsSync(join(dir, "auth.json"))).toBe(true);
  });
  it("refuses Next common writers before locks, directories, saves or removals", () => {
    const account = createAccount({ label: "Existing", providers: ["anthropic"] }); const before = readFileSync(join(root, "accounts.json"), "utf8");
    vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next"); const authPath = join(root, "agent", "accounts", "refused", "auth.json");
    for (const write of [() => createAccount({ label: "Refused", providers: ["anthropic"] }), () => patchAccount(account.id, { enabled: false }), () => reorderAccounts([account.id]), () => importAccountRecords([]), () => deleteAccount(account.id),
      () => saveAccountAnthropicCookieFile(authPath, cookie("claude.ai")), () => deleteAccountAnthropicCookieFile(authPath), () => saveAccountOpenCodeCookieFile(authPath, cookie("opencode.ai")), () => deleteAccountOpenCodeCookieFile(authPath),
      () => saveOllamaCookieFile("refused", cookie("ollama.com")), () => deleteOllamaCookieFile("refused"), () => writeAnthropicCreditBaseline(authPath, 10), () => writeOpenRouterAccountConfig(authPath, { managementKey: "PRIVATE" }), () => writeAccountOpenCodeGoWorkspace(authPath, "fixture")]) expect(write).toThrow("owned by Backend");
    expect(readFileSync(join(root, "accounts.json"), "utf8")).toBe(before); expect(readdirSync(root)).toEqual(["accounts.json"]);
  });
});
