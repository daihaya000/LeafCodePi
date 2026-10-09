import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitBranchRefs: vi.fn(),
  gitDirectoryError: vi.fn(() => null),
  gitLogGraph: vi.fn(),
}));

vi.mock("@/lib/git", () => ({
  gitBranchRefs: mocks.gitBranchRefs,
  gitDirectoryError: mocks.gitDirectoryError,
  gitLogGraph: mocks.gitLogGraph,
}));

import { GET } from "@backend-runtime/json-business/handlers/git/log/route";

const url = "http://localhost/api/git/log?directory=C%3A%5Crepo&limit=80&skip=0";

function makeRequest(ifNoneMatch?: string): NextRequest {
  return new NextRequest(url, {
    headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : undefined,
  });
}

describe("GET /api/git/log", () => {
  beforeEach(() => {
    mocks.gitBranchRefs.mockReset();
    mocks.gitBranchRefs.mockResolvedValue({ refs: [{ name: "main", hash: "abc123", current: true }], currentBranch: "main" });
    mocks.gitDirectoryError.mockReset();
    mocks.gitDirectoryError.mockReturnValue(null);
    mocks.gitLogGraph.mockReset();
    mocks.gitLogGraph.mockResolvedValue({
      commits: [{
        hash: "abc123",
        shortHash: "abc123",
        parents: [],
        subject: "initial commit",
        author: "user",
        authorEmail: "user@example.com",
        date: "2026-08-25T00:00:00Z",
      }],
      hasMore: false,
    });
  });

  it("returns an empty 304 for unchanged polled history", async () => {
    const first = await GET(makeRequest());
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag?.startsWith("W/")).toBe(true);

    const second = await GET(makeRequest(etag!));
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(mocks.gitLogGraph).toHaveBeenCalledTimes(2);
    expect(mocks.gitBranchRefs).toHaveBeenCalledTimes(2);
  });
});
