import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listPeerAccounts: vi.fn(), importPeerAccount: vi.fn() }));
vi.mock("@/lib/peer-auth/import", () => mocks);

import { GET, POST } from "./route";

beforeEach(() => {
  mocks.listPeerAccounts.mockReset().mockResolvedValue([]);
  mocks.importPeerAccount.mockReset().mockResolvedValue({ status: 201, body: { account: { label: "p", providers: ["anthropic"] } } });
});

describe("/api/peer-auth/import", () => {
  it("lists peer accounts with their connection state and forbids caching", async () => {
    mocks.listPeerAccounts.mockResolvedValue([{ id: "a1", label: "main", peerUrl: "http://a", providers: ["anthropic"], online: false }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ peers: [{ id: "a1", label: "main", peerUrl: "http://a", providers: ["anthropic"], online: false }] });
  });

  it("imports through POST and relays the status", async () => {
    const request = new Request("http://lcp.test/api/peer-auth/import", { method: "POST", body: JSON.stringify({ peerUrl: "http://a", token: "t", label: "p" }) });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(mocks.importPeerAccount).toHaveBeenCalledWith({ peerUrl: "http://a", token: "t", label: "p" });
  });
});
