import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  loadAgentDefinition: vi.fn(),
  getSetting: vi.fn(),
  parseDirectModelKey: vi.fn(),
  buildDirectGenerationCandidates: vi.fn(),
  generateDirectTextWithFallbackResult: vi.fn(),
}));

vi.mock("@/lib/agents", () => ({
  listAgents: mocks.listAgents,
  loadAgentDefinition: mocks.loadAgentDefinition,
}));
vi.mock("@/lib/pi/web-settings", () => ({ getSetting: mocks.getSetting }));
vi.mock("@/lib/direct-generation", () => ({
  parseDirectModelKey: mocks.parseDirectModelKey,
  buildDirectGenerationCandidates: mocks.buildDirectGenerationCandidates,
  generateDirectTextWithFallbackResult: mocks.generateDirectTextWithFallbackResult,
}));

import {
  formatAutoAgentPrompt,
  parseAutoAgentResponse,
  resolveAutoAgent,
  type AutoAgentCandidate,
} from "./auto-agent";

const candidates: AutoAgentCandidate[] = [
  { name: "build", description: "実装を進める", canModifyFiles: true },
  { name: "reviewer", description: "差分をレビューする", canModifyFiles: false },
];

beforeEach(() => {
  mocks.listAgents.mockReset();
  mocks.loadAgentDefinition.mockReset();
  mocks.getSetting.mockReset();
  mocks.parseDirectModelKey.mockReset();
  mocks.buildDirectGenerationCandidates.mockReset();
  mocks.generateDirectTextWithFallbackResult.mockReset();
  mocks.listAgents.mockReturnValue({
    agents: [
      {
        name: "reviewer",
        description: "差分をレビューする",
        enabled: true,
        tools: ["read", "grep"],
      },
      { name: "disabled", description: "使わない", enabled: false },
      {
        name: "build",
        description: "実装を進める",
        enabled: true,
        tools: ["read", "edit", "write"],
      },
    ],
    agentsDir: "",
  });
  mocks.getSetting.mockReturnValue(null);
  mocks.loadAgentDefinition.mockReturnValue(undefined);
  mocks.parseDirectModelKey.mockReturnValue(undefined);
  mocks.buildDirectGenerationCandidates.mockReturnValue([]);
});

describe("auto-agent", () => {
  it("formats history, the current prompt, and candidate descriptions as data", () => {
    const prompt = formatAutoAgentPrompt(
      [{ role: "user", text: "前回の依頼" }],
      "今回の差分を確認して",
      candidates,
    );

    expect(prompt).toContain("<conversation_history>\nUser: 前回の依頼\n</conversation_history>");
    expect(prompt).toContain("<current_request>\n今回の差分を確認して\n</current_request>");
    expect(prompt).toContain("reviewer");
    expect(prompt).toContain("差分をレビューする");
    expect(prompt).toContain('"canModifyFiles":false');
  });

  it("accepts only a candidate name from the JSON response", () => {
    expect(parseAutoAgentResponse('{"agent":"reviewer"}', candidates)).toBe("reviewer");
    expect(parseAutoAgentResponse("```json\n{\"agent\":\"build\"}\n```", candidates)).toBe("build");
    expect(parseAutoAgentResponse('{"agent":"missing"}', candidates)).toBeUndefined();
    expect(parseAutoAgentResponse('{"agent":"reviewer","reason":"差分"}', candidates)).toBeUndefined();
    expect(parseAutoAgentResponse("reviewer", candidates)).toBeUndefined();
  });

  it("uses a bounded system prompt when an agent has no description", async () => {
    mocks.listAgents.mockReturnValue({
      agents: [{ name: "custom", description: "", enabled: true }],
      agentsDir: "",
    });
    mocks.loadAgentDefinition.mockReturnValue({
      systemPrompt: "このエージェントはデータベース移行を安全に進めます。" + "x".repeat(1_000),
    });
    const model = { providerID: "p", modelID: "m" };
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"custom"}',
      model,
    });

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "DBを移行して" }),
    ).resolves.toBe("custom");

    const generated = mocks.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(generated.prompt).toContain("データベース移行を安全に進めます");
    expect(generated.prompt).not.toContain("x".repeat(601));
  });

  it("uses the configured direct model and prompt and ignores disabled agents", async () => {
    const model = { providerID: "llama-server", modelID: "selector" };
    mocks.getSetting.mockImplementation((key: string) =>
      key === "auto-agent-prompt" ? "レビューは reviewer を優先" : null,
    );
    mocks.parseDirectModelKey.mockReturnValue(model);
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"reviewer"}',
      model,
    });

    await expect(
      resolveAutoAgent({
        conversation: [{ role: "user", text: "差分を作りました" }],
        prompt: "レビューして",
      }),
    ).resolves.toBe("reviewer");

    const generated = mocks.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(generated.system).toContain("レビューは reviewer を優先");
    expect(generated.system).toContain("現在の依頼を最優先");
    expect(generated.system).toContain("canModifyFiles=false");
    expect(generated.prompt).toContain("レビューして");
    expect(generated.prompt).toContain("reviewer");
    expect(generated.prompt).toContain('"canModifyFiles":false');
    expect(generated.prompt).not.toContain("disabled");
  });

  it("prioritizes a current implementation request over prior review context", async () => {
    const model = { providerID: "p", modelID: "m" };
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"build"}',
      model,
    });

    await expect(
      resolveAutoAgent({
        conversation: [
          { role: "user", text: "レビューして" },
          { role: "assistant", text: "修正点があります" },
        ],
        prompt: "指摘事項を修正して",
      }),
    ).resolves.toBe("build");

    const generated = mocks.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(generated.prompt).toContain("<conversation_history>\nUser: レビューして");
    expect(generated.prompt).toContain(
      "<current_request>\n指摘事項を修正して\n</current_request>",
    );
    expect(generated.prompt).toContain('"name":"reviewer"');
    expect(generated.prompt).toContain('"canModifyFiles":false');
    expect(generated.prompt).toContain('"name":"build"');
    expect(generated.prompt).toContain('"canModifyFiles":true');
  });

  it("falls back to build when generation fails or returns an unknown name", async () => {
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model: { providerID: "p", modelID: "m" } }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"missing"}',
      model: { providerID: "p", modelID: "m" },
    });

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "実装して" }),
    ).resolves.toBe("build");

    mocks.generateDirectTextWithFallbackResult.mockRejectedValue(new Error("offline"));
    await expect(
      resolveAutoAgent({ conversation: [], prompt: "実装して" }),
    ).resolves.toBe("build");
  });

  it("uses the deterministic fallback when no generation model is available", async () => {
    await expect(
      resolveAutoAgent({ conversation: [], prompt: "実装して" }),
    ).resolves.toBe("build");
    expect(mocks.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });
});
