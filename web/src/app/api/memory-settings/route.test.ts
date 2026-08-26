import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  readLeafCodeMemorySettings: vi.fn(),
  writeLeafCodeMemorySettings: vi.fn(),
}));

vi.mock("@/lib/leafcode-memory-settings", () => settings);

import { GET, PUT } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/memory-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/memory-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.readLeafCodeMemorySettings.mockReturnValue({ settings: {}, valid: true });
    settings.writeLeafCodeMemorySettings.mockReturnValue({ settings: { memoryMode: "policy-only" }, valid: true });
  });

  it("returns and updates the memory config", async () => {
    expect(await (await GET()).json()).toEqual({ settings: {}, valid: true });

    const response = await PUT(request({ memoryMode: "policy-only" }));

    expect(response.status).toBe(200);
    expect(settings.writeLeafCodeMemorySettings).toHaveBeenCalledWith({ memoryMode: "policy-only" });
  });

  it("returns the validation status from the settings boundary", async () => {
    settings.writeLeafCodeMemorySettings.mockImplementation(() => {
      throw Object.assign(new Error("memoryCharLimit が不正です"), { status: 400 });
    });

    const response = await PUT(request({ memoryCharLimit: -1 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "memoryCharLimit が不正です" });
  });
});
