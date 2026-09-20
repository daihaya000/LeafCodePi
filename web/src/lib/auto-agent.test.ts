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
  AUTO_AGENT_RULES,
  AUTO_AGENT_SYSTEM_INSTRUCTION,
  autoAgentHasOwnModel,
  formatAutoAgentPrompt,
  matchAutoAgentByRule,
  parseAutoAgentResponse,
  resolveAutoAgent,
  type AutoAgentCandidate,
} from "./auto-agent";

import { DEFAULT_AGENT } from "@/lib/default-agent";

const candidates: AutoAgentCandidate[] = [
  { name: "builder", description: "実装を進める", canModifyFiles: true },
  { name: "reviewer", description: "差分をレビューする", canModifyFiles: false },
];

const researchCandidates: AutoAgentCandidate[] = [
  ...candidates,
  { name: "researcher", description: "調査する", canModifyFiles: false },
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
        name: "builder",
        description: "実装を進める",
        enabled: true,
        tools: ["read", "edit", "write"],
      },
      { name: DEFAULT_AGENT, description: "既定のエージェント", enabled: true },
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

  it("caps router history and current request together", () => {
    const prompt = formatAutoAgentPrompt(
      [{ role: "user", text: "h".repeat(8_000) }],
      "r".repeat(4_000),
      candidates,
    );
    const history = prompt.match(/<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/)?.[1] ?? "";
    const current = prompt.match(/<current_request>\n([\s\S]*?)\n<\/current_request>/)?.[1] ?? "";

    expect(Array.from(history).length + Array.from(current).length).toBeLessThanOrEqual(8_000);
  });

  it("accepts only a candidate name from the JSON response", () => {
    expect(parseAutoAgentResponse('{"agent":"reviewer"}', candidates)).toBe("reviewer");
    expect(parseAutoAgentResponse("```json\n{\"agent\":\"builder\"}\n```", candidates)).toBe("builder");
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
        { name: "builder", description: "実装を進める", enabled: true },
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
        prompt: "差分を確認して",
      }),
    ).resolves.toBe("reviewer");

    const generated = mocks.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(generated.system).toBe("レビューは reviewer を優先");
    expect(generated.prompt).toContain("差分を確認して");
    expect(generated.prompt).toContain("reviewer");
    expect(generated.prompt).toContain('"canModifyFiles":false');
    expect(generated.prompt).not.toContain("disabled");
  });

  it("uses the default system instruction when no prompt is configured", async () => {
    const model = { providerID: "p", modelID: "m" };
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"builder"}',
      model,
    });

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "この方針で進めて" }),
    ).resolves.toBe("builder");

    const generated = mocks.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(generated.system).toBe(AUTO_AGENT_SYSTEM_INSTRUCTION);
  });

  it("prioritizes a current implementation request over prior review context", async () => {
    const model = { providerID: "p", modelID: "m" };
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"builder"}',
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
    ).resolves.toBe("builder");

    const generated = mocks.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    expect(generated.prompt).toContain("<conversation_history>\nUser: レビューして");
    expect(generated.prompt).toContain(
      "<current_request>\n指摘事項を修正して\n</current_request>",
    );
    expect(generated.prompt).toContain('"name":"reviewer"');
    expect(generated.prompt).toContain('"canModifyFiles":false');
    expect(generated.prompt).toContain('"name":"builder"');
    expect(generated.prompt).toContain('"canModifyFiles":true');
  });

  it("falls back to the default agent when generation fails or returns an unknown name", async () => {
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model: { providerID: "p", modelID: "m" } }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"missing"}',
      model: { providerID: "p", modelID: "m" },
    });

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "この方針で進めて" }),
    ).resolves.toBe(DEFAULT_AGENT);

    mocks.generateDirectTextWithFallbackResult.mockRejectedValue(new Error("offline"));
    await expect(
      resolveAutoAgent({ conversation: [], prompt: "この方針で進めて" }),
    ).resolves.toBe(DEFAULT_AGENT);
  });

  it("uses the deterministic fallback when no generation model is available", async () => {
    await expect(
      resolveAutoAgent({ conversation: [], prompt: "この方針で進めて" }),
    ).resolves.toBe(DEFAULT_AGENT);
    expect(mocks.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });

  it("skips the router call when only one candidate is enabled", async () => {
    mocks.listAgents.mockReturnValue({
      agents: [{ name: "builder", description: "実装", enabled: true }],
      agentsDir: "",
    });
    mocks.buildDirectGenerationCandidates.mockReturnValue([
      { model: { providerID: "p", modelID: "m" } },
    ]);

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "実装して" }),
    ).resolves.toBe("builder");
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

  it("bounds candidates and keeps the default agent available as the fallback", async () => {
    const model = { providerID: "p", modelID: "m" };
    mocks.listAgents.mockReturnValue({
      agents: [
        ...Array.from({ length: 30 }, (_, index) => ({
          name: `agent-${index}`,
          description: "x".repeat(600),
          enabled: true,
        })),
        { name: DEFAULT_AGENT, description: "既定のエージェント", enabled: true },
      ],
      agentsDir: "",
    });
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: JSON.stringify({ agent: DEFAULT_AGENT }),
      model,
    });

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "この方針で進めて" }),
    ).resolves.toBe(DEFAULT_AGENT);

    const generated = mocks.generateDirectTextWithFallbackResult.mock.calls[0]?.[0];
    const agentData = JSON.parse(
      generated.prompt.match(/<agents>\n([\s\S]*?)\n<\/agents>/)?.[1] ?? "[]",
    );
    expect(agentData).toHaveLength(24);
    expect(agentData.some((agent: { name?: string }) => agent.name === DEFAULT_AGENT)).toBe(true);
    expect(agentData[0]?.name).toBe("agent-0");
    expect(agentData[0]?.description).toHaveLength(300);
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

      const result = resolveAutoAgent({ conversation: [], prompt: "この方針で進めて" });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toBe(DEFAULT_AGENT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("REPRO: an empty conversation omits history from the router prompt", async () => {
    const model = { providerID: "p", modelID: "m" };
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"builder"}',
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

describe("auto-agent rule-first", () => {
  it("keeps the rule table super-narrow", () => {
    expect(AUTO_AGENT_RULES.map((rule) => rule.kind)).toEqual([
      "implement",
      "review",
      "research",
    ]);
    expect(AUTO_AGENT_RULES.flatMap((rule) => [...rule.promptKeywords])).toEqual([
      "実装",
      "implement",
      "レビュー",
      "review",
      "調査",
      "research",
    ]);
  });

  it("matches a unique implement candidate from canModifyFiles and narrow keywords", () => {
    expect(matchAutoAgentByRule("この関数を実装して", candidates)).toEqual({
      agent: "builder",
      kind: "implement",
    });
    expect(matchAutoAgentByRule("Please implement this helper", candidates)).toEqual({
      agent: "builder",
      kind: "implement",
    });
  });

  it("matches a unique review candidate from canModifyFiles and narrow keywords", () => {
    expect(matchAutoAgentByRule("この差分をレビューして", candidates)).toEqual({
      agent: "reviewer",
      kind: "review",
    });
    expect(matchAutoAgentByRule("Please review this diff", candidates)).toEqual({
      agent: "reviewer",
      kind: "review",
    });
  });

  it("matches a unique research candidate from canModifyFiles and narrow keywords", () => {
    expect(matchAutoAgentByRule("原因を調査して", researchCandidates)).toEqual({
      agent: "researcher",
      kind: "research",
    });
    expect(matchAutoAgentByRule("Please research this failure", researchCandidates)).toEqual({
      agent: "researcher",
      kind: "research",
    });
  });

  it("returns undefined when the request is ambiguous or mixed", () => {
    expect(matchAutoAgentByRule("この方針で進めて", candidates)).toBeUndefined();
    expect(matchAutoAgentByRule("指摘事項を修正して", candidates)).toBeUndefined();
    expect(matchAutoAgentByRule("実装してからレビューして", candidates)).toBeUndefined();
    expect(matchAutoAgentByRule("preview the plan", candidates)).toBeUndefined();
    expect(matchAutoAgentByRule("implementation notes", candidates)).toBeUndefined();
  });

  it("returns undefined when canModifyFiles or agent keywords are not unique", () => {
    expect(
      matchAutoAgentByRule("実装して", [
        { name: "writer", description: "コードを書く", canModifyFiles: true },
        { name: "reviewer", description: "差分をレビューする", canModifyFiles: false },
      ]),
    ).toBeUndefined();
    expect(
      matchAutoAgentByRule("実装して", [
        { name: "builder", description: "実装を進める", canModifyFiles: true },
        { name: "coder", description: "実装も担当する", canModifyFiles: true },
      ]),
    ).toBeUndefined();
  });

  it("skips the LLM on a confident implement request and logs the skip", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.buildDirectGenerationCandidates.mockReturnValue([
      { model: { providerID: "p", modelID: "m" } },
    ]);

    try {
      await expect(
        resolveAutoAgent({ conversation: [], prompt: "この関数を実装して" }),
      ).resolves.toBe("builder");
      expect(mocks.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "[auto-agent] rule-first skip LLM",
        JSON.stringify({ agent: "builder", kind: "implement" }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("skips the LLM on a confident review request", async () => {
    mocks.buildDirectGenerationCandidates.mockReturnValue([
      { model: { providerID: "p", modelID: "m" } },
    ]);

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "この差分をレビューして" }),
    ).resolves.toBe("reviewer");
    expect(mocks.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });

  it("skips the LLM on a confident research request", async () => {
    mocks.listAgents.mockReturnValue({
      agents: [
        {
          name: "reviewer",
          description: "差分をレビューする",
          enabled: true,
          tools: ["read", "grep"],
        },
        {
          name: "builder",
          description: "実装を進める",
          enabled: true,
          tools: ["read", "edit", "write"],
        },
        {
          name: "researcher",
          description: "調査する",
          enabled: true,
          tools: ["read", "grep"],
        },
      ],
      agentsDir: "",
    });
    mocks.buildDirectGenerationCandidates.mockReturnValue([
      { model: { providerID: "p", modelID: "m" } },
    ]);

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "原因を調査して" }),
    ).resolves.toBe("researcher");
    expect(mocks.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });

  it("keeps the LLM router for ambiguous requests", async () => {
    const model = { providerID: "p", modelID: "m" };
    mocks.buildDirectGenerationCandidates.mockReturnValue([{ model }]);
    mocks.generateDirectTextWithFallbackResult.mockResolvedValue({
      text: '{"agent":"builder"}',
      model,
    });

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "この方針で進めて" }),
    ).resolves.toBe("builder");
    expect(mocks.generateDirectTextWithFallbackResult).toHaveBeenCalled();
  });

  it("falls back to DEFAULT when the LLM fails on an ambiguous request", async () => {
    mocks.buildDirectGenerationCandidates.mockReturnValue([
      { model: { providerID: "p", modelID: "m" } },
    ]);
    mocks.generateDirectTextWithFallbackResult.mockRejectedValue(new Error("offline"));

    await expect(
      resolveAutoAgent({ conversation: [], prompt: "この方針で進めて" }),
    ).resolves.toBe(DEFAULT_AGENT);
  });

  it("falls back to DEFAULT when rule matching throws", async () => {
    mocks.listAgents.mockReturnValue({
      agents: [
        {
          name: "reviewer",
          description: "差分をレビューする",
          enabled: true,
          tools: ["read", "grep"],
        },
        {
          name: "builder",
          description: "実装を進める",
          enabled: true,
          tools: ["read", "edit", "write"],
        },
        { name: DEFAULT_AGENT, description: "既定のエージェント", enabled: true },
      ],
      agentsDir: "",
    });
    mocks.buildDirectGenerationCandidates.mockReturnValue([
      { model: { providerID: "p", modelID: "m" } },
    ]);
    const prompt = new String("実装して") as string;
    Object.defineProperty(prompt, "trim", {
      value: () => {
        throw new Error("rule boom");
      },
    });

    await expect(
      resolveAutoAgent({ conversation: [], prompt }),
    ).resolves.toBe(DEFAULT_AGENT);
    expect(mocks.generateDirectTextWithFallbackResult).not.toHaveBeenCalled();
  });
});
