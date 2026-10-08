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
  refreshLiveSessionsForAgentDefinition: vi.fn(),
}));

vi.mock("@/lib/agents", () => mocks);
vi.mock("@/lib/pi/harness", () => ({
  reloadLiveSessionsContext: mocks.reloadLiveSessionsContext,
  refreshLiveSessionsForAgentDefinition: mocks.refreshLiveSessionsForAgentDefinition,
}));

import { DELETE, PATCH } from "@backend-runtime/json-business/handlers/agents/[name]/route";

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

function flushImmediate() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("PATCH /api/agents/:name tool permissions", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.listAgents.mockReturnValue({ agents: [] });
    mocks.reloadLiveSessionsContext.mockResolvedValue({ reloaded: true });
  });

  it("rejects disabling default without scheduling a session reload", async () => {
    mocks.setAgentEnabled.mockImplementationOnce(() => {
      throw new Error("default エージェントは無効化できません");
    });
    mocks.agentsErrorStatus.mockReturnValueOnce(403);

    const response = await PATCH(request({ enabled: false }), context("default"));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("無効化できません");
    expect(mocks.setAgentEnabled).toHaveBeenCalledWith("default", false);
    expect(mocks.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });

  it("rejects a non-string tool name", async () => {
    const response = await PATCH(request({ tools: ["read", 123] }), context());

    expect(response.status).toBe(400);
    expect(mocks.setAgentTools).not.toHaveBeenCalled();
  });

  it("passes an empty allowlist through to the agent store", async () => {
    const response = await PATCH(request({ tools: [] }), context());
    await flushImmediate();

    expect(response.status).toBe(200);
    expect(mocks.setAgentTools).toHaveBeenCalledWith("custom", []);
    expect(mocks.reloadLiveSessionsContext).not.toHaveBeenCalled();
    expect(mocks.refreshLiveSessionsForAgentDefinition).not.toHaveBeenCalled();
  });

  it("restores inheritance with null, not an empty allowlist", async () => {
    const response = await PATCH(request({ tools: null }), context());
    await flushImmediate();
    expect(response.status).toBe(200);
    expect(mocks.setAgentTools).toHaveBeenCalledWith("custom", null);
  });

  it.each([
    { tools: ["read"] },
    { model: "openai/test", thinking: "high", tools: [] },
    { enabled: true, tools: null },
    { systemPrompt: "Changed", tools: ["read"] },
  ])("rejects default tool updates before any compound write: %j", async (body) => {
    const response = await PATCH(request(body), context("default"));
    await flushImmediate();
    expect(response.status).toBe(403);
    expect(mocks.setAgentModel).not.toHaveBeenCalled();
    expect(mocks.setAgentThinking).not.toHaveBeenCalled();
    expect(mocks.setAgentEnabled).not.toHaveBeenCalled();
    expect(mocks.setAgentTools).not.toHaveBeenCalled();
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(mocks.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });

  it.each([{ tools: null }, { tools: [] }])("preserves tools %j through full user-definition updates", async ({ tools }) => {
    const response = await PATCH(request({ systemPrompt: "Changed", tools }), context());
    expect(response.status).toBe(200);
    expect(mocks.updateAgent).toHaveBeenCalledWith(expect.objectContaining({ name: "custom", tools: tools ?? undefined }));
    expect(mocks.setAgentTools).not.toHaveBeenCalled();
    await flushImmediate();
  });

  it("allows default prompt/model updates without tools", async () => {
    expect((await PATCH(request({ model: "openai/test" }), context("default"))).status).toBe(200);
    expect(mocks.setAgentModel).toHaveBeenCalledWith("default", "openai/test");
    expect((await PATCH(request({ systemPrompt: "Changed" }), context("default"))).status).toBe(200);
    expect(mocks.updateAgent).toHaveBeenCalledWith(expect.objectContaining({ name: "default", systemPrompt: "Changed", tools: undefined }));
    await flushImmediate();
  });

  it("returns without waiting for a live session reload", async () => {
    let releaseReload!: () => void;
    const reload = new Promise<{ reloaded: boolean }>((resolve) => {
      releaseReload = () => resolve({ reloaded: true });
    });
    mocks.reloadLiveSessionsContext.mockReturnValueOnce(reload);

    const responsePromise = PATCH(request({ tools: ["read"] }), context());
    const response = await Promise.race([
      responsePromise,
      new Promise<null>((resolve) => setImmediate(() => resolve(null))),
    ]);
    releaseReload();
    await responsePromise;
    await flushImmediate();

    expect(response).not.toBeNull();
    expect((response as Response).status).toBe(200);
    expect(mocks.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });

  it("applies model, effort, and tools when sent together", async () => {
    const response = await PATCH(
      request({ model: "openai-codex/gpt-5.6", thinking: "high", tools: ["read", "grep"] }),
      context(),
    );
    await flushImmediate();

    expect(response.status).toBe(200);
    expect(mocks.setAgentModel).toHaveBeenCalledWith("custom", "openai-codex/gpt-5.6");
    expect(mocks.setAgentThinking).toHaveBeenCalledWith("custom", "high");
    expect(mocks.setAgentTools).toHaveBeenCalledWith("custom", ["read", "grep"]);
  });
});

describe("DELETE /api/agents/:name", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.deleteAgent.mockReturnValue({ agents: [] });
    mocks.reloadLiveSessionsContext.mockResolvedValue({ reloaded: true });
  });

  it("returns deletion without applying live changes before the owner command checkpoint", async () => {
    const response = await DELETE(new NextRequest("http://localhost/api/agents/custom", { method: "DELETE" }), context());
    await flushImmediate();

    expect(response.status).toBe(200);
    expect(mocks.deleteAgent).toHaveBeenCalledWith("custom");
    expect(mocks.reloadLiveSessionsContext).not.toHaveBeenCalled();
  });
});
