import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evaluateTypeSafe } from "./typesafe-system-one";

describe("evaluateTypeSafe", () => {
  const request = {
    state: "connectivity test",
    model: "jev-latest" as const,
    questions: {
      connected: { type: "noul" as const, instructions: "Is this a test?" },
    },
  };

  it("posts a System One request with the resolved API key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { connected: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
        { status: 200 },
      ),
    );

    await expect(evaluateTypeSafe(request, { apiKey: "secret", fetchImpl })).resolves.toMatchObject({
      model: "jev-1.13.0",
      answers: { connected: { noul: 0.9 } },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("reads the API key from the environment without creating a runtime", async () => {
    const previous = process.env.TYPESAFE_API_KEY;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = mkdtempSync(join(tmpdir(), "typesafe-system-one-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.TYPESAFE_API_KEY = "env-secret";
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { connected: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
        { status: 200 },
      ),
    );

    try {
      await evaluateTypeSafe(request, { fetchImpl });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer env-secret" }),
      }),
    );
  });

  it("rejects a non-success response", async () => {
    await expect(
      evaluateTypeSafe(request, {
        apiKey: "secret",
        fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      }),
    ).rejects.toThrow("TypeSafe API error: 401");
  });
});
