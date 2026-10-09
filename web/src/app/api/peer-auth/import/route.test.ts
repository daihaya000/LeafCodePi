import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEBUI_TOKEN = "peer-import-webui-token";
const mocks = vi.hoisted(() => ({ listPeerAccounts: vi.fn(), importPeerAccount: vi.fn() }));
vi.mock("@/lib/peer-auth/import", () => ({ listPeerAccounts: mocks.listPeerAccounts, importPeerAccount: mocks.importPeerAccount }));

import { GET, POST } from "@backend-runtime/json-business/handlers/peer-auth/import/route";

beforeEach(() => {
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
  vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", WEBUI_TOKEN);
  mocks.listPeerAccounts.mockReset().mockResolvedValue([]);
  mocks.importPeerAccount.mockReset().mockResolvedValue({ status: 201, body: { account: { label: "p", providers: ["anthropic"] } } });
});

afterEach(() => vi.unstubAllEnvs());

describe("/api/peer-auth/import", () => {
  it("lists peer accounts with their connection state and forbids caching", async () => {
    mocks.listPeerAccounts.mockResolvedValue([{ id: "a1", label: "main", peerUrl: "http://a", providers: ["anthropic"], online: false }]);
    const response = await GET(new Request("http://lcp.test/api/peer-auth/import", { headers: { authorization: `Bearer ${WEBUI_TOKEN}` } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ peers: [{ id: "a1", label: "main", peerUrl: "http://a", providers: ["anthropic"], online: false }] });
  });

  it("imports through POST and relays the status", async () => {
    const request = new Request("http://lcp.test/api/peer-auth/import", {
      method: "POST", headers: { authorization: `Bearer ${WEBUI_TOKEN}` },
      body: JSON.stringify({ peerUrl: "http://a", token: "t", label: "p" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(mocks.importPeerAccount).toHaveBeenCalledWith({ peerUrl: "http://a", token: "t", label: "p" });
  });

  it("blocks peer probes and imports when WebUI token auth is unavailable", async () => {
    vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "");
    vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "");
    const getResponse = await GET(new Request("http://lcp.test/api/peer-auth/import"));
    const postResponse = await POST(new Request("http://lcp.test/api/peer-auth/import", { method: "POST", body: "{}" }));
    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(getResponse.headers.get("cache-control")).toBe("no-store");
    expect(mocks.listPeerAccounts).not.toHaveBeenCalled();
    expect(mocks.importPeerAccount).not.toHaveBeenCalled();
  });
});
