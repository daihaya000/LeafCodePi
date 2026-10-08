import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { emptyUsage } from "@/lib/codexbar";
import { GET } from "@backend-runtime/json-business/handlers/codexbar/usage/route";

const { fetchNativeUsage, attachTokenUsage } = vi.hoisted(() => ({
  fetchNativeUsage: vi.fn(),
  attachTokenUsage: vi.fn((usage: unknown) => usage),
}));

vi.mock("@/lib/codexbar/orchestrator", () => ({ fetchNativeUsage }));
vi.mock("@/lib/codexbar/token-usage", () => ({ attachTokenUsage }));

describe("GET /api/codexbar/usage", () => {
  it("rejects an account scope without an account id", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/codexbar/usage?scope=account"),
    );
    expect(response.status).toBe(400);
    expect(fetchNativeUsage).not.toHaveBeenCalled();
  });

  it("passes scope and refresh to the orchestrator", async () => {
    fetchNativeUsage.mockResolvedValueOnce(emptyUsage("none"));
    const response = await GET(
      new NextRequest(
        "http://localhost/api/codexbar/usage?scope=account&accountId=acc-1&refresh=1",
      ),
    );
    expect(response.status).toBe(200);
    expect(fetchNativeUsage).toHaveBeenCalledWith({
      forceRefresh: true,
      scope: { kind: "account", accountId: "acc-1" },
    });
  });

  it("allows usage requests for paused account scopes", async () => {
    fetchNativeUsage.mockResolvedValueOnce(emptyUsage("none"));
    const response = await GET(
      new NextRequest(
        "http://localhost/api/codexbar/usage?scope=account&accountId=paused",
      ),
    );
    expect(response.status).toBe(200);
    expect(fetchNativeUsage).toHaveBeenLastCalledWith({
      forceRefresh: false,
      scope: { kind: "account", accountId: "paused" },
    });
  });

  it("decorates usage outside the native cache with token telemetry", async () => {
    const cached = emptyUsage("test");
    const decorated = { ...cached, reason: "token telemetry attached" };
    fetchNativeUsage.mockResolvedValueOnce(cached);
    attachTokenUsage.mockReturnValueOnce(decorated);
    const response = await GET(new NextRequest("http://localhost/api/codexbar/usage"));
    expect(attachTokenUsage).toHaveBeenLastCalledWith(cached);
    expect(await response.json()).toEqual(decorated);
  });

  it("rejects an unknown scope", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/codexbar/usage?scope=other"),
    );
    expect(response.status).toBe(400);
  });
});
