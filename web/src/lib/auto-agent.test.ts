import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  getSetting: vi.fn(),
  parseDirectModelKey: vi.fn(),
  buildDirectGenerationCandidates: vi.fn(),
  generateDirectTextWithFallbackResult: vi.fn(),
}));

vi.mock("@/lib/agents", () => ({ listAgents: mocks.listAgents }));
vi.mock("@/lib/pi/web-settings", () => ({ getSetting: mocks.getSetting }));
vi.mock("@/lib/direct-generation", () => ({
  parseDirectModelKey: mocks.parseDirectModelKey,
  buildDirectGenerationCandidates: mocks.buildDirectGenerationCandidates,
  generateDirectTextWithFallbackResult: mocks.generateDirectTextWithFallbackResult,
}));

import {
  autoAgentHasOwnModel,
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

  it("does not expose an agent system prompt when its description is empty", async () => {
    mocks.listAgents.mockReturnValue({
      agents: [
        {
          name: "custom",
          description: "",
          enabled: true,
          systemPrompt: "SECRET_INTERNAL_INSTRUCTION",
        },
        { name: "build", description: "実装を進める", enabled: true },
      ],
      agentsDir: "",
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
    expect(generated.prompt).toContain("（説明なし）");
    expect(generated.prompt).not.toContain("SECRET_INTERNAL_INSTRUCTION");
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

  it("skips the router call when only one candidate is enabled", async () => {
    mocks.listAgents.mockReturnValue({
      agents: [{ name: "build", description: "実装", enabled: true }],
      agentsDir: "",
    });
    mocks.buildDirectGenerationCandidates.mockReturnValue([
      { model: { providerID: "p", modelID: "m" } },
    ]);

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "実装して" }),
    ).resolves.toBe("build");
    expect(mocks.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });

  it("reports whether selection has its own generation model", () => {
    expect(autoAgentHasOwnModel()).toBe(false);

    mocks.parseDirectModelKey.mockImplementation((value: unknown) =>
      value === "configured" ? { providerID: "p", modelID: "m" } : undefined,
    );
    mocks.getSetting.mockImplementation((key: string) =>
      key === "generation-fallback-model" ? "configured" : null,
    );

    expect(autoAgentHasOwnModel()).toBe(true);
  });

  it("fails closed when no enabled agent exists", async () => {
    mocks.listAgents.mockReturnValue({ agents: [], agentsDir: "" });

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "実装して" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });

  it("bounds candidates and keeps build available as the fallback", async () => {
    const model = { providerID: "p", modelID: "m" };
    mocks.listAgents.mockReturnValue({
      agents: [
        ...Array.from({ length: 30 }, (_, index) => ({
          name: `agent-${index}`,
          description: "x".repeat(600),
          enabled: true,
        })),
        { name: "build", description: "実装", enabled: true },
      ],
      agentsDir: "",
    });
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"build"}',
      model,
    });

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "実装して" }),
    ).resolves.toBe("build");

    const generated = mocks.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    const agentData = JSON.parse(
      generated.prompt.match(/<agents>\n([\s\S]*?)\n<\/agents>/)?.[1] ?? "[]",
    );
    expect(agentData).toHaveLength(24);
    expect(agentData.some((agent: { name?: string }) => agent.name === "build")).toBe(true);
    expect(agentData[0]?.name).toBe("agent-0");
  });

  it("uses one deadline across direct-generation fallbacks", async () => {
    vi.useFakeTimers();
    try {
      const model = { providerID: "p", modelID: "m" };
      mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
      mocks.generateDirectTextWithFallbackResult.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );

      const result = resolveAutoAgent({ conversation: [], prompt: "実装して" });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toBe("build");
    } finally {
      vi.useRealTimers();
    }
  });

  it("REPRO: an empty conversation omits history from the router prompt", async () => {
    const model = { providerID: "p", modelID: "m" };
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"build"}',
      model,
    });

    // Task creation passes conversation: [], so the router sees no prior turns.
    await resolveAutoAgent({ conversation: [], prompt: "続けて" });
    const emptyPrompt = mocks.generateDirectTextWithFallbackResult.mock.calls[0]?.[0]?.prompt;
    expect(emptyPrompt).toContain("<conversation_history>\n（なし）\n</conversation_history>");

    // Follow-up paths pass real history, which is included.
    await resolveAutoAgent({ conversation: [{ role: "user", text: "前回の依頼" }], prompt: "続けて" });
    const withPrompt = mocks.generateDirectTextWithFallbackResult.mock.calls[1]?.[0]?.prompt;
    expect(withPrompt).toContain("前回の依頼");
    expect(withPrompt).not.toContain("\n（なし）\n");
  });
});
