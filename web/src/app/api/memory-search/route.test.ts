import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const memorySearch = vi.hoisted(() => ({
  searchLeafCodeMemory: vi.fn(),
}));

vi.mock("@/lib/memory-search", () => ({
  MAX_MEMORY_SEARCH_QUERY_LENGTH: 200,
  searchLeafCodeMemory: memorySearch.searchLeafCodeMemory,
}));

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/memory-search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/memory-search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memorySearch.searchLeafCodeMemory.mockReturnValue([{ content: "matched" }]);
  });

  it("returns direct memory search results", async () => {
    const response = await POST(request({ query: " deployment " }));

    expect(response.status).toBe(200);
    expect(memorySearch.searchLeafCodeMemory).toHaveBeenCalledWith("deployment");
    expect(await response.json()).toEqual({ results: [{ content: "matched" }] });
  });

  it("rejects missing and oversized queries", async () => {
    const missing = await POST(request({ query: " " }));
    const oversized = await POST(request({ query: "x".repeat(201) }));

    expect(missing.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(memorySearch.searchLeafCodeMemory).not.toHaveBeenCalled();
  });
});
