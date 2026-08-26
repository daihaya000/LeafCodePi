import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setMode = vi.hoisted(() => vi.fn());

vi.mock("@/lib/pi/harness", () => ({
  jsonError: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: typeof error === "object" && error && "status" in error ? (error as { status?: number }).status ?? 500 : 500,
  }),
  setProviderAccountRoutingMode: setMode,
}));

import { PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/providers/openai-codex", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("PATCH /api/providers/:id", () => {
  beforeEach(() => setMode.mockReset());

  it("persists a valid mode", async () => {
    const response = await PATCH(request({ accountRoutingMode: "integrated" }), {
      params: Promise.resolve({ id: "openai-codex" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountRoutingMode: "integrated" });
    expect(setMode).toHaveBeenCalledWith("openai-codex", "integrated");
  });

  it("rejects malformed modes before calling the store", async () => {
    const response = await PATCH(request({ accountRoutingMode: "auto" }), {
      params: Promise.resolve({ id: "openai-codex" }),
    });
    expect(response.status).toBe(400);
    expect(setMode).not.toHaveBeenCalled();
  });

  it("passes unsupported providers to the domain validation", async () => {
    setMode.mockRejectedValueOnce(Object.assign(new Error("対象外"), { status: 400 }));
    const response = await PATCH(
      new NextRequest("http://127.0.0.1:3010/api/providers/llama-server", {
        method: "PATCH",
        body: JSON.stringify({ accountRoutingMode: "integrated" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: "llama-server" }) },
    );
    expect(response.status).toBe(400);
  });
});
