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

  it("rejects a non-success response", async () => {
    await expect(
      evaluateTypeSafe(request, {
        apiKey: "secret",
        fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      }),
    ).rejects.toThrow("TypeSafe API error: 401");
  });
});
