import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentsErrorStatus: vi.fn(() => 500),
  deleteAgent: vi.fn(),
  listAgents: vi.fn(() => ({ agents: [] })),
  readUserAgent: vi.fn(),
  setAgentEnabled: vi.fn(),
  setAgentModel: vi.fn(),
  setAgentThinking: vi.fn(),
  setAgentTools: vi.fn(),
  updateAgent: vi.fn(),
  reloadLiveSessionsContext: vi.fn(async () => ({ reloaded: true })),
}));

vi.mock("@/lib/agents", () => mocks);
vi.mock("@/lib/pi/harness", () => ({ reloadLiveSessionsContext: mocks.reloadLiveSessionsContext }));

import { PATCH } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/agents/custom", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(name = "custom") {
  return { params: Promise.resolve({ name }) };
}

describe("PATCH /api/agents/:name tool permissions", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.listAgents.mockReturnValue({ agents: [] });
    mocks.reloadLiveSessionsContext.mockResolvedValue({ reloaded: true });
  });

  it("rejects a non-string tool name", async () => {
    const response = await PATCH(request({ tools: ["read", 123] }), context());

    expect(response.status).toBe(400);
    expect(mocks.setAgentTools).not.toHaveBeenCalled();
  });

  it("passes an empty allowlist through to the agent store", async () => {
    const response = await PATCH(request({ tools: [] }), context());

    expect(response.status).toBe(200);
    expect(mocks.setAgentTools).toHaveBeenCalledWith("custom", []);
    expect(mocks.reloadLiveSessionsContext).toHaveBeenCalledOnce();
  });

  it("applies model, effort, and tools when sent together", async () => {
    const response = await PATCH(
      request({ model: "openai-codex/gpt-5.6", thinking: "high", tools: ["read", "grep"] }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mocks.setAgentModel).toHaveBeenCalledWith("custom", "openai-codex/gpt-5.6");
    expect(mocks.setAgentThinking).toHaveBeenCalledWith("custom", "high");
    expect(mocks.setAgentTools).toHaveBeenCalledWith("custom", ["read", "grep"]);
  });
});
