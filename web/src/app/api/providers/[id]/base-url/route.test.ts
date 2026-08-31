import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getBaseUrl = vi.hoisted(() => vi.fn());
const setBaseUrl = vi.hoisted(() => vi.fn());

vi.mock("@/lib/pi/harness", () => ({
  getProviderBaseUrl: getBaseUrl,
  setProviderBaseUrl: setBaseUrl,
  jsonError: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status:
      typeof error === "object" && error && "status" in error
        ? (error as { status?: number }).status ?? 500
        : 500,
  }),
}));

import { GET, PUT } from "./route";

function request(method: "GET" | "PUT", body?: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/providers/ollama-cloud/base-url", {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

describe("/api/providers/:id/base-url", () => {
  beforeEach(() => {
    getBaseUrl.mockReset();
    setBaseUrl.mockReset();
    getBaseUrl.mockReturnValue("https://example.com/v1");
  });

  it("returns the effective URL for an editable provider", async () => {
    const response = await GET(request("GET"), {
      params: Promise.resolve({ id: "ollama-cloud" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ baseUrl: "https://example.com/v1" });
    expect(getBaseUrl).toHaveBeenCalledWith("ollama-cloud");
  });

  it("saves a valid URL with PUT", async () => {
    const response = await PUT(request("PUT", { baseUrl: "https://api.example/v1" }), {
      params: Promise.resolve({ id: "leafcodecloud" }),
    });

    expect(response.status).toBe(200);
    expect(setBaseUrl).toHaveBeenCalledWith("leafcodecloud", "https://api.example/v1");
    expect(await response.json()).toEqual({ baseUrl: "https://example.com/v1" });
  });

  it("rejects unsupported providers and malformed bodies", async () => {
    const unsupported = await GET(request("GET"), {
      params: Promise.resolve({ id: "anthropic" }),
    });
    expect(unsupported.status).toBe(400);

    const malformed = await PUT(request("PUT", { baseUrl: 123 }), {
      params: Promise.resolve({ id: "ollama-cloud" }),
    });
    expect(malformed.status).toBe(400);
    expect(setBaseUrl).not.toHaveBeenCalled();
  });

  it("returns domain validation errors", async () => {
    setBaseUrl.mockImplementationOnce(() => {
      throw Object.assign(new Error("URLが不正です"), { status: 400 });
    });
    const response = await PUT(request("PUT", { baseUrl: "not-a-url" }), {
      params: Promise.resolve({ id: "ollama-cloud" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "URLが不正です" });
  });
});
