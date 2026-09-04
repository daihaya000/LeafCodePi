import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  setProviderModelContextWindow: vi.fn(),
  setProviderOrModelEnabled: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => ({
  jsonError: mocks.jsonError,
  setProviderOrModelEnabled: mocks.setProviderOrModelEnabled,
}));
vi.mock("@/lib/provider-model-state", () => ({
  setProviderModelContextWindow: mocks.setProviderModelContextWindow,
}));

import { PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/provider-models/provider%3A%3Amodel", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/provider-models/[key]", () => {
  beforeEach(() => {
    mocks.jsonError.mockClear();
    mocks.setProviderModelContextWindow.mockReset();
    mocks.setProviderOrModelEnabled.mockReset();
  });

  it("rejects a non-object body before accessing fields", async () => {
    const response = await PATCH(
      request(null),
      { params: Promise.resolve({ key: "provider::model" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.setProviderOrModelEnabled).not.toHaveBeenCalled();
    expect(mocks.setProviderModelContextWindow).not.toHaveBeenCalled();
  });
});
