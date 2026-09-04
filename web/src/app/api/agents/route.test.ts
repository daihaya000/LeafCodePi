import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentsErrorStatus: vi.fn(() => 500),
  createAgent: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock("@/lib/agents", () => mocks);

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agents", () => {
  beforeEach(() => {
    mocks.createAgent.mockReset();
    mocks.createAgent.mockReturnValue({ name: "build" });
  });

  it("rejects a non-object request body before creating an agent", async () => {
    const response = await POST(request(null));

    expect(response.status).toBe(400);
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it("rejects a non-string description before creating an agent", async () => {
    const response = await POST(
      request({ name: "reviewer", systemPrompt: "Review", description: 123 }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it("rejects aliases containing non-string values before creating an agent", async () => {
    const response = await POST(
      request({ name: "reviewer", systemPrompt: "Review", aliases: [123] }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it("rejects tools containing non-string values before creating an agent", async () => {
    const response = await POST(
      request({ name: "reviewer", systemPrompt: "Review", tools: [123] }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it("rejects fallback models containing non-string values before creating an agent", async () => {
    const response = await POST(
      request({ name: "reviewer", systemPrompt: "Review", fallbackModels: [123] }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
});
