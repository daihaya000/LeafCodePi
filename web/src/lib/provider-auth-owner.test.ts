import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderLoginSession } from "@/lib/pi/auth-login";
import { dispatchJsonBusinessRequest } from "@backend-runtime/json-business/index";
import { openProviderLoginEvents } from "@backend-runtime/json-business/provider-auth-events";
import { publicJsonBusinessResult } from "@shared/json-business-contract.mjs";
const api = vi.hoisted(() => ({ startProviderLogin: vi.fn(), answerProviderLogin: vi.fn(), cancelProviderLogin: vi.fn(), completeProviderLoginCallback: vi.fn(), logoutProvider: vi.fn(), getActiveProviderLogin: vi.fn(), subscribeProviderLogin: vi.fn(), jsonError: (error: { status?: number }) => ({ error: "PRIVATE SDK FAILURE", status: error?.status ?? 500 }) }));
vi.mock("@/lib/pi/harness", () => api);
let root: string, session: ProviderLoginSession | null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-auth-owner-")); session = null;
  for (const [key, value] of Object.entries({ LEAFCODE_PI_DATA_DIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), LEAFCODE_PI_PROCESS_ROLE: "backend", LEAFCODE_PI_WEBUI_AUTH: "" })) vi.stubEnv(key, value);
  for (const mock of Object.values(api)) if (vi.isMockFunction(mock)) mock.mockReset();
  api.startProviderLogin.mockImplementation(async (providerId, type) => {
    session = new ProviderLoginSession(providerId, type);
    void session.run({ login: async (_p: string, _t: string, interaction: { prompt: (p: unknown) => Promise<string> }) => {
      const secret = await interaction.prompt({ type: "secret", message: "API key" });
      writeFileSync(join(root, "mock-sdk-credential.json"), JSON.stringify({ secret }));
    } } as never);
    return { sessionId: session.id };
  });
  api.getActiveProviderLogin.mockImplementation(() => session ? { providerId: session.providerId, sessionId: session.id, authType: session.authType, accountId: session.accountId } : null);
  api.subscribeProviderLogin.mockImplementation(listener => session!.subscribe(listener));
  api.answerProviderLogin.mockImplementation((id, value, sid) => { if (!session || sid !== session.id) throw Object.assign(new Error("Mismatch"), { status: 409 }); session.answer(id, value); });
  api.cancelProviderLogin.mockImplementation(() => { session?.cancel(); session = null; });
  api.completeProviderLoginCallback.mockResolvedValue(undefined); api.logoutProvider.mockResolvedValue(undefined);
});
afterEach(() => { session?.cancel(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function command(suffix: string, body?: unknown, id = randomUUID(), method = "POST", provider = "fixture") {
  const route = `providers/${provider}/${suffix}`;
  const result = await dispatchJsonBusinessRequest({ route, method, operationId: id, url: `http://localhost/api/${route}`, authorized: true, headers: { host: "localhost" }, body: new TextEncoder().encode(JSON.stringify(body ?? {})) });
  return publicJsonBusinessResult(route, result)!;
}
const events = (id: string, provider = "fixture") => openProviderLoginEvents({ route: provider, method: "GET", url: `http://localhost/api/providers/${provider}/login/events?sessionId=${id}`, authorized: true, headers: {} });
describe("single Backend authentication owner", () => {
  it("retains a real login prompt across subscriber disconnect and completes through the same owner", async () => {
    const id = randomUUID(), started = await command("login", { type: "api_key" }, id);
    expect(started.status).toBe(200); expect(started.body).toMatchObject({ operation: { execution: "complete" } }); expect(started.body?.mutation).toBeUndefined();
    const sid = started.body!.sessionId as string;
    const first = events(sid).body!.getReader(); const initial = new TextDecoder().decode((await first.read()).value);
    expect(initial).toContain("event: started"); await first.cancel(); expect(api.cancelProviderLogin).not.toHaveBeenCalled();
    const second = events(sid).body!.getReader(); let content = "", prompt = "";
    while (!prompt) { content += new TextDecoder().decode((await second.read()).value); const match = /event: prompt\ndata: (.+)/.exec(content); if (match) prompt = JSON.parse(match[1]).id; }
    const wrong = await command("login/answer", { sessionId: sid, promptId: prompt, value: "fixture-secret" }, undefined, "POST", "other"); expect(wrong.status).toBe(409);
    const answered = await command("login/answer", { sessionId: sid, promptId: prompt, value: "fixture-secret" }); expect(answered.status).toBe(200);
    for (;;) { const chunk = await second.read(); if (chunk.done) break; content += new TextDecoder().decode(chunk.value); }
    expect(content).toContain('"ok":true'); expect(content).not.toContain("fixture-secret"); expect(readFileSync(join(root, "mock-sdk-credential.json"), "utf8")).toContain("fixture-secret");
    expect(readFileSync(join(root, "provider-auth-command.json"), "utf8")).not.toContain("fixture-secret");
    expect((await command("login", { type: "api_key" }, id)).status).toBe(409); expect(api.startProviderLogin).toHaveBeenCalledOnce();
  });
  it("rejects missing/stale/provider-mismatched streams and session mutation", async () => {
    const started = await command("login", { type: "api_key" }), sid = started.body!.sessionId as string;
    for (const response of [events("stale"), events(sid, "other")]) { const body = await response.text(); expect(body).toContain('"ok":false'); expect(body).not.toContain("event: prompt"); }
    expect((await command("login/answer", { sessionId: "stale", promptId: "p", value: "x" })).status).toBe(409);
    expect((await command("login/answer", {}, undefined, "DELETE")).status).toBe(400);
    expect((await command("login/answer", { sessionId: sid }, undefined, "DELETE")).status).toBe(200);
  });
  it("reports asynchronous SDK failure via safe owner events, not credential success in the start ACK", async () => {
    api.startProviderLogin.mockImplementationOnce(async () => {
      session = new ProviderLoginSession("fixture", "oauth");
      await session.run({ login: async () => { throw Error("PRIVATE SDK secret"); } } as never); return { sessionId: session.id };
    });
    const started = await command("login", { type: "oauth" }); expect(started.status).toBe(200);
    const body = await events(started.body!.sessionId as string).text(); expect(body).toContain('"ok":false'); expect(body).not.toContain("PRIVATE");
  });
  it("drops an oversized subscriber event without canceling the underlying login", async () => {
    const started = await command("login", { type: "api_key" }); const unsubscribe = vi.fn();
    api.subscribeProviderLogin.mockImplementationOnce(listener => { listener({ type: "notify", event: { type: "progress", message: "界".repeat(32768) } }); return unsubscribe; });
    const body = await events(started.body!.sessionId as string).text(); expect(body).not.toContain("event: notify");
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(api.cancelProviderLogin).not.toHaveBeenCalled();
  });
  it("Next cannot execute the credential-owning session even before an SDK interaction", async () => {
    vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next"); const login = vi.fn();
    await expect(new ProviderLoginSession("fixture", "api_key").run({ login } as never)).rejects.toThrow("owned by Backend"); expect(login).not.toHaveBeenCalled();
  });
  it("cancel is scoped to the selected provider/session and secret-bearing callback exceptions are redacted", async () => {
    const started = await command("login", { type: "oauth" }), sid = started.body!.sessionId as string;
    expect((await command("login/answer", { sessionId: sid }, undefined, "DELETE", "other")).status).toBe(409); expect(api.cancelProviderLogin).not.toHaveBeenCalled();
    api.completeProviderLoginCallback.mockRejectedValueOnce(Object.assign(new Error("PRIVATE code"), { status: 401 }));
    const callback = await command("login/callback", { sessionId: sid, input: "http://localhost/callback?code=fixture" }); expect(callback.status).toBe(401); expect(JSON.stringify(callback)).not.toContain("PRIVATE");
  });
});
