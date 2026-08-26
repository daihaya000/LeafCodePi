import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { emptyUsage } from "@/lib/codexbar";
import { GET } from "./route";

const { fetchNativeUsage } = vi.hoisted(() => ({
  fetchNativeUsage: vi.fn(),
}));

vi.mock("@/lib/codexbar/orchestrator", () => ({ fetchNativeUsage }));

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

  it("rejects an unknown scope", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/codexbar/usage?scope=other"),
    );
    expect(response.status).toBe(400);
  });
});
