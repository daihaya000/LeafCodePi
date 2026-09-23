import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JEV_MODEL_SETTINGS } from "@/lib/jev-model-settings";
import { evaluateTypeSafe } from "./typesafe-system-one";

const mocks = vi.hoisted(() => ({ readSettings: vi.fn(), readKey: vi.fn(), recordUsage: vi.fn() }));
vi.mock("./jev-model-config", () => ({ readJevModelSettings: mocks.readSettings, readJevApiKey: mocks.readKey }));
vi.mock("@/lib/codexbar/providers/typesafe", () => ({ recordTypesafeUsage: mocks.recordUsage }));

const request = {
  state: "connectivity test",
  questions: { connected: { type: "noul" as const, instructions: "Is this a test?" } },
};
const result = {
  model: "jev-1.13.0",
  answers: { connected: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 1, output_tokens: 2 },
};
const respond = (body: unknown = result) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS });
  mocks.readKey.mockResolvedValue("test-only-key");
});

describe("evaluateTypeSafe", () => {
  it("preserves the default TypeSafe endpoint, model, auth and usage accounting", async () => {
    const fetchImpl = respond();
    await expect(evaluateTypeSafe(request, { fetchImpl })).resolves.toEqual(result);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.typesafe.ai/v1/systemone", expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: { Authorization: "Bearer test-only-key", "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, model: "jev-latest" }),
    }));
    expect(mocks.recordUsage).toHaveBeenCalledWith(result.usage);
  });

  it("uses the configured compatible endpoint and model without charging TypeSafe", async () => {
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "compatible", compatibleBaseUrl: "http://localhost:8080/v1", compatibleModel: "local-judge", timeoutMs: 5000 };
    mocks.readSettings.mockReturnValue(settings);
    mocks.readKey.mockResolvedValue("custom-test-key");
    const fetchImpl = respond();
    await evaluateTypeSafe(request, { fetchImpl });
    expect(mocks.readKey).toHaveBeenCalledWith(settings);
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:8080/v1/systemone", expect.objectContaining({
      body: JSON.stringify({ ...request, model: "local-judge" }),
      headers: expect.objectContaining({ Authorization: "Bearer custom-test-key" }),
    }));
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("supports keyless compatible servers and reads changes on the next call", async () => {
    const fetchImpl = respond();
    await evaluateTypeSafe(request, { fetchImpl });
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "compatible", compatibleBaseUrl: "http://localhost:9000", compatibleModel: "new-model" });
    mocks.readKey.mockResolvedValue(undefined);
    const nextFetch = respond();
    await evaluateTypeSafe(request, { fetchImpl: nextFetch });
    expect(nextFetch).toHaveBeenCalledWith("http://localhost:9000/systemone", expect.objectContaining({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, model: "new-model" }),
    }));
  });

  it("never retries another provider after failure", async () => {
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "compatible", compatibleBaseUrl: "http://localhost:9000", compatibleModel: "judge" });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(evaluateTypeSafe(request, { fetchImpl })).rejects.toThrow("Jev API error: 401");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("combines caller cancellation with the configured timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = respond();
    await evaluateTypeSafe(request, { fetchImpl, signal: controller.signal });
    expect(timeout).toHaveBeenCalledWith(2000);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    timeout.mockRestore();
  });

  it.each([
    null,
    { ...result, answers: {} },
    { ...result, answers: { connected: { type: "choice", choice: "yes" } } },
    { ...result, answers: { connected: { type: "noul", noul: 1.1 } } },
    { ...result, answers: { connected: { type: "noul", noul: "0.9" } } },
    { ...result, usage: { input_tokens: -1, output_tokens: 0 } },
  ])("rejects malformed responses before consumers or accounting", async (body) => {
    await expect(evaluateTypeSafe(request, { fetchImpl: respond(body) })).rejects.toThrow("Jev API returned");
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("validates choice options, score bounds and confidence", async () => {
    const typedRequest = {
      state: "test",
      questions: {
        choice: { type: "choice" as const, instructions: "Which?", criteria: { a: null, b: null } },
        score: { type: "score" as const, instructions: "Rate?", criteria: ["low", "high"] },
      },
    };
    const answers = { choice: { type: "choice", choice: "a", confidence: 0.8 }, score: { type: "score", score: 0.5, confidence: 0.7 } };
    await expect(evaluateTypeSafe(typedRequest, { fetchImpl: respond({ ...result, answers }) })).resolves.toBeDefined();
    for (const invalid of [
      { ...answers, choice: { ...answers.choice, choice: "unknown" } },
      { ...answers, choice: { ...answers.choice, confidence: 2 } },
      { ...answers, score: { ...answers.score, score: 2 } },
    ]) {
      await expect(evaluateTypeSafe(typedRequest, { fetchImpl: respond({ ...result, answers: invalid }) })).rejects.toThrow("Jev API returned");
    }
  });
});
