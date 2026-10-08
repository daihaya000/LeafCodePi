import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relayConfiguration } from "./configuration-relay";
import { setSetting } from "@/lib/pi/web-settings";
import { CONFIGURATION_HEADERS as H } from "@shared/configuration-contract.mjs";

let root: string;
const fetcher = vi.fn();
function request(route = "settings/history-page-size", body = '{"value":"100"}') {
  return new Request(`http://localhost/api/${route}`, { method: "PUT", headers: { "content-type": "application/json" }, body });
}
function reply(_url: string, options: RequestInit, apply = "not-required", status = 200) {
  const headers = new Headers(options.headers);
  return Response.json({ value: "100", mutation: { operationId: headers.get(H.operation), saved: true, saveStatus: "complete",
    revision: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", apply, recovery: "none", token: "PRIVATE" } }, { status });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-next-config-"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", root);
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next");
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "");
  vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "");
  vi.stubEnv("LEAFCODE_PI_BIND_HOST", "0.0.0.0");
  vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", "backend-private-token-1234567890123456789");
  vi.stubEnv("LEAFCODE_PI_BACKEND_GENERATION", "");
  vi.stubEnv("LEAFCODE_PI_BACKEND_GENERATION_FILE", "");
  fetcher.mockReset().mockImplementation(async (url, opts) => reply(url, opts));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("Next configuration ingress", () => {
  it("relays without a local settings write and exposes only the public mutation DTO", async () => {
    const response = await relayConfiguration(request(), "settings/history-page-size");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ value: "100", mutation: { saved: true, apply: "not-required" } });
    expect(readdirSync(root)).toEqual([]);
    expect(() => setSetting("history-page-size", "100")).toThrow("Configuration is owned by Backend");
    expect(readdirSync(root)).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("preserves save/apply partial success without retrying or falling back", async () => {
    fetcher.mockImplementation(async (url, opts) => reply(url, opts, "failed", 503));
    const response = await relayConfiguration(request(), "settings/history-page-size");
    const body = await response.json();
    expect(response.status).toBe(503); expect(body.mutation.saved).toBe(true);
    expect(body.mutation.apply).toBe("failed"); expect(body.mutation.revision).toBeTruthy();
    expect(body.mutation.token).toBeUndefined(); expect(fetcher).toHaveBeenCalledOnce(); expect(readdirSync(root)).toEqual([]);
  });
  it("cannot claim unsaved after a lost owner response", async () => {
    fetcher.mockRejectedValue(new Error("secret network exception"));
    const response = await relayConfiguration(request(), "settings/history-page-size");
    const body = await response.json();
    expect(response.status).toBe(503); expect(body.mutation).toMatchObject({ saved: null, apply: "unknown", recovery: "unknown" });
    expect(JSON.stringify(body)).not.toContain("secret"); expect(fetcher).toHaveBeenCalledOnce(); expect(readdirSync(root)).toEqual([]);
  });
  it("unconfigured Backend is a known refusal, even in development", async () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("LEAFCODE_PI_BACKEND_TOKEN", "");
    const response = await relayConfiguration(request(), "settings/history-page-size");
    expect(response.status).toBe(503); expect((await response.json()).mutation.saved).toBe(false);
    expect(fetcher).not.toHaveBeenCalled(); expect(readdirSync(root)).toEqual([]);
  });
  it("rejects authentication, cross-site and excessive body before the owner sees them", async () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "UI-TOKEN");
    expect((await relayConfiguration(request(), "settings/history-page-size")).status).toBe(401);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "");
    const cross = new Request("http://localhost/api/settings/x", { method: "PUT", headers: { origin: "https://evil.example" }, body: "{}" });
    expect((await relayConfiguration(cross, "settings/history-page-size")).status).toBe(403);
    const large = new Request("http://localhost/api/jev-model", { method: "PUT", headers: { "content-length": "16385" }, body: "{}" });
    expect((await relayConfiguration(large, "jev-model")).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves loopback notification access and never forwards browser credentials", async () => {
    vi.stubEnv("LEAFCODE_PI_BIND_HOST", "127.0.0.1");
    expect((await relayConfiguration(request("notifications", '{"enabled":true}'), "notifications")).status).toBe(200);
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required"); vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "UI-TOKEN");
    const req = new Request("http://localhost/api/notifications", { method: "PUT", headers: { cookie: "leafcode-pi-token=UI-TOKEN", "content-type": "application/json" }, body: '{"enabled":true}' });
    expect((await relayConfiguration(req, "notifications")).status).toBe(200);
    const headers = new Headers(fetcher.mock.calls.at(-1)![1].headers);
    expect(headers.get(H.authorized)).toBe("1"); expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).not.toContain("UI-TOKEN");
  });
  it("malformed success without a mutation acknowledgement is unknown, not full success", async () => {
    fetcher.mockResolvedValue(Response.json({ ok: true }));
    const response = await relayConfiguration(request(), "settings/history-page-size");
    expect(response.status).toBe(503); expect((await response.json()).mutation.saved).toBeNull();
  });
});
