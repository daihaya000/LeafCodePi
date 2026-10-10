import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state = vi.hoisted(() => ({ authPath: "", providers: ["opendesign"], peer: false }));
const undiciFetch = vi.hoisted(() => vi.fn());
vi.mock("undici", async original => ({ ...(await original<typeof import("undici")>()), fetch: undiciFetch }));
vi.mock("@/lib/accounts", () => ({ accountAuthPath: () => state.authPath, resolvePiAgentDir: async () => "unused",
  getAccount: (id: string) => id === "acc-od" ? { id, providers: state.providers } : null }));
vi.mock("@/lib/peer-auth/account-runtime-options", () => ({ isPeerAccount: () => state.peer }));
vi.mock("@/lib/pi/harness", () => ({ jsonError: (error: Error & { status?: number }) => ({ error: error.message, status: error.status ?? 500 }) }));
import { POST, DELETE } from "@backend-runtime/json-business/handlers/accounts/[id]/opendesign-cookie/route";
import { configurationRequest } from "@backend-runtime/configuration/http";
import { hasOpenDesignCookie, saveOpenDesignCookie } from "@backend-runtime/lib/codexbar/providers/opendesign";
const dirs: string[] = [];
function setup() { const dir = mkdtempSync(join(tmpdir(), "leafcode-opendesign-cookie-route-")); dirs.push(dir); state.authPath = join(dir, "auth.json"); }
function request(cookies: unknown) { return configurationRequest(new Request("http://localhost/api/accounts/acc-od/opendesign-cookie", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cookies }),
}), true); }
const context = { params: Promise.resolve({ id: "acc-od" }) };
afterEach(() => { undiciFetch.mockReset(); state.providers = ["opendesign"]; state.peer = false; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("OpenDesign cookie owner route", () => {
  it("validates and saves cookie/workspace privately, then deletes both", async () => {
    setup(); undiciFetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith("/current") ? { workspaceId: "workspace-a" }
      : url.endsWith("/wallet/balance") ? { balanceUsd: "12" } : { eligible: false, windows: [] })));
    const saved = await POST(request("session=fixture-secret"), context);
    expect(saved.status).toBe(200); expect(await saved.json()).toEqual({ ok: true, configured: true });
    expect(hasOpenDesignCookie(state.authPath)).toBe(true);
    expect(await (await DELETE(request(null), context)).json()).toEqual({ ok: true, configured: false });
    expect(hasOpenDesignCookie(state.authPath)).toBe(false);
  });
  it("does not overwrite the previous valid cookie on failed validation", async () => {
    setup(); saveOpenDesignCookie(state.authPath, "session=previous", "workspace-a");
    undiciFetch.mockImplementation(async () => new Response('{"error":"session=fixture-secret"}', { status: 401 }));
    const rejected = await POST(request("session=fixture-secret"), context);
    expect(rejected.status).toBe(400); expect(await rejected.text()).not.toContain("fixture-secret");
    expect(hasOpenDesignCookie(state.authPath)).toBe(true);
  });
  it("rejects invalid bodies and missing/wrong-provider/peer-managed accounts before requests", async () => {
    setup(); expect((await POST(request(null), context)).status).toBe(400);
    expect((await POST(request("session=a"), { params: Promise.resolve({ id: "missing" }) })).status).toBe(404);
    state.providers = ["openai-codex"]; expect((await POST(request("session=a"), context)).status).toBe(400);
    state.providers = ["opendesign"]; state.peer = true; expect((await POST(request("session=a"), context)).status).toBe(403);
    expect(undiciFetch).not.toHaveBeenCalled();
    expect(hasOpenDesignCookie(state.authPath)).toBe(false);
  });
});
