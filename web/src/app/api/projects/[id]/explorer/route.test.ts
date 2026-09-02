import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/pi/harness", () => ({ getProjects: vi.fn() }));

describe("POST /api/projects/[id]/explorer", () => {
  it("rejects direct WebUI requests so Explorer cannot be started remotely", async () => {
    const response = await POST();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "ExplorerはホストPCからのみ起動できます",
    });
  });
});
