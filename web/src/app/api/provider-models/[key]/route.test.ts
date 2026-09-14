import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  invalidateHealthCache: vi.fn(),
  setProviderModelContextWindow: vi.fn(),
  setProviderModelDefaultThinkingLevel: vi.fn(),
  setProviderOrModelEnabled: vi.fn(),
}));

vi.mock("@/lib/pi/harness", () => ({
  invalidateHealthCache: mocks.invalidateHealthCache,
  jsonError: mocks.jsonError,
  setProviderOrModelEnabled: mocks.setProviderOrModelEnabled,
}));
vi.mock("@/lib/provider-model-state", () => ({
  setProviderModelContextWindow: mocks.setProviderModelContextWindow,
  setProviderModelDefaultThinkingLevel: mocks.setProviderModelDefaultThinkingLevel,
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
    mocks.invalidateHealthCache.mockReset();
    mocks.setProviderModelContextWindow.mockReset();
    mocks.setProviderModelDefaultThinkingLevel.mockReset();
    mocks.setProviderOrModelEnabled.mockReset();
  });

  it("persists a valid default thinking level", async () => {
    const response = await PATCH(
      request({ defaultThinkingLevel: "high", accountId: "acc-1" }),
      { params: Promise.resolve({ key: "provider::model" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.setProviderModelDefaultThinkingLevel).toHaveBeenCalledWith(
      "provider",
      "model",
      "high",
      "acc-1",
    );
    expect(mocks.invalidateHealthCache).toHaveBeenCalledOnce();
  });

  it("clears a saved default with null", async () => {
    const response = await PATCH(
      request({ defaultThinkingLevel: null }),
      { params: Promise.resolve({ key: "provider::model" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.setProviderModelDefaultThinkingLevel).toHaveBeenCalledWith(
      "provider",
      "model",
      null,
      undefined,
    );
  });

  it("rejects an invalid default thinking level", async () => {
    const response = await PATCH(
      request({ defaultThinkingLevel: "turbo" }),
      { params: Promise.resolve({ key: "provider::model" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.setProviderModelDefaultThinkingLevel).not.toHaveBeenCalled();
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
