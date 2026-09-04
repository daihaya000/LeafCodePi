import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveProviderModelsOrder: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);

import { PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/provider-models/order", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/provider-models/order", () => {
  beforeEach(() => {
    mocks.saveProviderModelsOrder.mockReset();
    mocks.saveProviderModelsOrder.mockResolvedValue(undefined);
  });

  it("rejects non-array order fields before saving", async () => {
    const response = await PATCH(request({ providerOrder: "anthropic" }));

    expect(response.status).toBe(400);
    expect(mocks.saveProviderModelsOrder).not.toHaveBeenCalled();
  });
});
