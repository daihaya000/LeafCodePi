import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JEV_MODEL_SETTINGS, jevModelEndpoint } from "@/lib/jev-model-settings";
import { evaluateTypeSafe } from "./typesafe-system-one";

const mocks = vi.hoisted(() => ({ readSettings: vi.fn(), readKey: vi.fn(), resolve: vi.fn(), list: vi.fn(), readState: vi.fn(), readRouting: vi.fn(), recordUsage: vi.fn(), recordLatency: vi.fn() }));
vi.mock("./jev-model-config", () => ({ readJevModelSettings: mocks.readSettings, resolveJevModelConnection: mocks.resolve }));
vi.mock("./harness", () => ({ listJevModels: mocks.list }));
vi.mock("@/lib/codexbar/providers/typesafe", () => ({ recordTypesafeUsage: mocks.recordUsage }));
vi.mock("@/lib/provider-model-state", () => ({ readProviderModelState: mocks.readState, accountProviderModelKey: (id: string, accountId?: string) => accountId ? `${accountId}::${id}` : id }));
vi.mock("@/lib/provider-routing", () => ({ readProviderRouting: mocks.readRouting, accountRoutingMode: (id: string, state: { modes: Record<string, string> }) => state.modes[id] ?? "separate" }));
vi.mock("./jev-latency", () => ({ recordJevLatency: mocks.recordLatency }));

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
  mocks.readState.mockReturnValue({ providerOrder: [], modelOrder: {} });
  mocks.readRouting.mockReturnValue({ modes: {} });
  mocks.resolve.mockImplementation(async (settings) => ({ ...jevModelEndpoint(settings), apiKey: await mocks.readKey(settings) }));
  mocks.list.mockImplementation(async () => {
    const settings = mocks.readSettings();
    const refs = settings.enabledModels ?? (settings.registeredModel ? [settings.registeredModel] : []);
    return refs.map((ref: { providerId: string; modelId: string; accountId?: string }) => ({
      ...ref, providerName: ref.providerId, name: ref.modelId, baseUrl: "https://example.test/v1", source: "catalog",
    }));
  });
});

describe("evaluateTypeSafe", () => {
  function useOpenAi() {
    const ref = { providerId: "openai", modelId: "gpt-6-luna", accountId: "openai-one" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: ref });
    mocks.resolve.mockResolvedValue({ baseUrl: "https://api.openai.com/v1", model: ref.modelId,
      api: "decisions", apiKey: "openai-test-key", headers: { "OpenAI-Project": "test-project" } });
    return ref;
  }

  it.each(["openrouter", "commandcode", "custom-decisions"])("uses the resolved Decisions contract for any provider (%s)", async (providerId) => {
    const ref = { providerId, modelId: "vendor/future-decision", accountId: "one" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: ref });
    mocks.resolve.mockResolvedValue({ baseUrl: "https://gateway.example/v1", model: ref.modelId,
      api: "decisions", apiKey: "gateway-test-key", headers: { "X-Title": "LeafCodePi" } });
    const fetchImpl = respond({ model: ref.modelId, answers: [{ type: "predicate", name: "connected", probability: 0.9 }], usage: result.usage });
    await expect(evaluateTypeSafe(request, { fetchImpl })).resolves.toMatchObject({ model: ref.modelId, answers: result.answers });
    expect(fetchImpl).toHaveBeenCalledWith("https://gateway.example/v1/decisions", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer gateway-test-key", "X-Title": "LeafCodePi" }),
      body: JSON.stringify({ model: ref.modelId, input: request.state, questions: [{ type: "predicate", name: "connected", instructions: "Is this a test?" }] }),
    }));
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("honors an explicit System One contract over an OpenAI model-name inference", async () => {
    useOpenAi();
    mocks.resolve.mockResolvedValue({ baseUrl: "https://gateway.example/v1", model: "gpt-6-luna", api: "systemone" });
    const fetchImpl = respond();
    await expect(evaluateTypeSafe(request, { fetchImpl })).resolves.toEqual(result);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://gateway.example/v1/systemone");
  });

  it("routes OpenAI Decisions through existing account auth and exposes Jev-compatible judgments", async () => {
    useOpenAi();
    const fetchImpl = respond({ model: "gpt-6-luna", answers: [{ type: "predicate", name: "connected", probability: 0.9 }],
      usage: { input_tokens: 42, output_tokens: 0 } });
    await expect(evaluateTypeSafe(request, { fetchImpl, apiKey: "unrelated-key" })).resolves.toEqual({
      model: "gpt-6-luna", answers: result.answers, usage: { input_tokens: 42, output_tokens: 0 },
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/decisions", expect.objectContaining({
      method: "POST", redirect: "error",
      headers: { Authorization: "Bearer openai-test-key", "Content-Type": "application/json", "OpenAI-Project": "test-project" },
      body: JSON.stringify({ model: "gpt-6-luna", input: request.state,
        questions: [{ type: "predicate", name: "connected", instructions: "Is this a test?" }] }),
    }));
    expect(mocks.recordLatency).toHaveBeenCalledWith("gpt-6-luna", expect.any(Number));
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("validates converted Decisions choice and score scalars at the shared boundary", async () => {
    useOpenAi();
    const typedRequest = { state: { message: "test" }, questions: {
      team: { type: "choice" as const, instructions: "Which?", criteria: { a: null, none: null } },
      severity: { type: "score" as const, instructions: "Rate?", criteria: ["low", "high"] },
    } };
    const answers = [
      { type: "choice", name: "team", choice: "a", confidence: 0.8,
        probabilities: [{ value: "a", probability: 0.9 }, { value: "none", probability: 0.1 }] },
      { type: "score", name: "severity", score: 0.7, confidence: 0.4,
        probabilities: [{ value: 0, probability: 0.3 }, { value: 1, probability: 0.7 }] },
    ];
    const body = { model: "gpt-6-luna", answers, usage: { input_tokens: 42, output_tokens: 0 } };
    await expect(evaluateTypeSafe(typedRequest, { fetchImpl: respond(body) })).resolves.toMatchObject({ answers: {
      team: { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.9, none: 0.1 } },
      severity: { type: "score", score: 0.7, confidence: 0.4, probabilities: { "0": 0.3, "1": 0.7 } },
    } });
    for (const invalid of [
      { ...body, model: undefined },
      { ...body, usage: undefined },
      { ...body, usage: { input_tokens: 42, output_tokens: -1 } },
      { ...body, answers: [{ ...answers[0], choice: "unknown" }, answers[1]] },
      { ...body, answers: [{ ...answers[0], confidence: 2 }, answers[1]] },
      { ...body, answers: [answers[0], { ...answers[1], score: 2 }] },
    ]) {
      await expect(evaluateTypeSafe(typedRequest, { fetchImpl: respond(invalid) })).rejects.toThrow("Jev API returned");
    }
    expect(mocks.recordLatency).toHaveBeenCalledTimes(1);
  });

  it("retains Decisions cancellation and timeout without contacting a fallback", async () => {
    const first = useOpenAi();
    const second = { providerId: "typesafe", modelId: "jev-latest" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", enabledModels: [first, second] });
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn().mockImplementation(async (_url, init) => {
      expect(init.signal.aborted).toBe(false);
      controller.abort();
      expect(init.signal.aborted).toBe(true);
      throw new Error("cancelled");
    });
    try {
      await expect(evaluateTypeSafe(request, { fetchImpl, signal: controller.signal })).rejects.toThrow("cancelled");
      expect(timeout).toHaveBeenCalledWith(DEFAULT_JEV_MODEL_SETTINGS.timeoutMs);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    { type: "predicate", name: "connected", probability: 1.5 },
    { type: "predicate", name: "connected", probability: "0.9" },
    { type: "refusal", name: "connected" },
  ])("rejects invalid Decisions answers before consumers and latency accounting", async (answer) => {
    useOpenAi();
    await expect(evaluateTypeSafe(request, { fetchImpl: respond({ model: "gpt-6-luna", answers: [answer],
      usage: { input_tokens: 42, output_tokens: 0 } }) })).rejects.toThrow();
    expect(mocks.recordLatency).not.toHaveBeenCalled();
  });

  it("falls back from a Decisions refusal only to another explicitly enabled model", async () => {
    const first = useOpenAi();
    const second = { providerId: "typesafe", modelId: "jev-latest" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", enabledModels: [first, second] });
    mocks.resolve.mockResolvedValueOnce({ baseUrl: "https://api.openai.com/v1", model: first.modelId, api: "decisions", apiKey: "openai-test-key" })
      .mockResolvedValueOnce({ baseUrl: "https://api.typesafe.ai/v1", model: second.modelId, apiKey: "typesafe-test-key" });
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ model: first.modelId,
      answers: [{ type: "refusal", name: "connected" }], usage: { input_tokens: 42, output_tokens: 0 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify(result)));
    await expect(evaluateTypeSafe(request, { fetchImpl })).resolves.toEqual(result);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["https://api.openai.com/v1/decisions", "https://api.typesafe.ai/v1/systemone"]);
    expect(mocks.recordLatency).toHaveBeenCalledTimes(1);
  });

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
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("records the answering model's round-trip latency once per success", async () => {
    await evaluateTypeSafe(request, { fetchImpl: respond() });
    expect(mocks.recordLatency).toHaveBeenCalledTimes(1);
    const [model, duration] = mocks.recordLatency.mock.calls[0];
    expect(model).toBe(result.model);
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("records only the model that answered and never failed attempts", async () => {
    const first = { providerId: "openrouter", modelId: "jev-a" };
    const second = { providerId: "typesafe", modelId: "jev-b" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: first, enabledModels: [first, second] });
    mocks.readState.mockReturnValue({ providerOrder: ["openrouter", "typesafe"], modelOrder: {} });
    mocks.resolve.mockImplementation(async (settings) => ({ baseUrl: `https://${settings.registeredModel.providerId}.example/v1`, model: settings.registeredModel.modelId }));
    const answered = { ...result, model: "jev-b" };
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify(answered)));
    await evaluateTypeSafe(request, { fetchImpl });
    expect(mocks.recordLatency).toHaveBeenCalledTimes(1);
    expect(mocks.recordLatency.mock.calls[0][0]).toBe("jev-b");

    mocks.recordLatency.mockClear();
    await expect(evaluateTypeSafe(request, { fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 500 })) })).rejects.toThrow("Jev API error: 500");
    expect(mocks.recordLatency).not.toHaveBeenCalled();
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

  it("routes a registered model through its current account credentials and preserves provider headers", async () => {
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: { providerId: "openrouter", modelId: "typesafe/jev-1.13", accountId: "one" } });
    mocks.resolve.mockResolvedValueOnce({ baseUrl: "https://openrouter.ai/api/v1", model: "typesafe/jev-1.13", apiKey: "account-test-key", headers: { "X-Title": "LeafCodePi" } });
    const fetchImpl = respond();
    await evaluateTypeSafe(request, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith("https://openrouter.ai/api/v1/systemone", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer account-test-key", "X-Title": "LeafCodePi" }),
      body: JSON.stringify({ ...request, model: "typesafe/jev-1.13" }),
    }));
    expect(mocks.recordUsage).not.toHaveBeenCalled();
    mocks.resolve.mockRejectedValueOnce(new Error("account disabled"));
    await expect(evaluateTypeSafe(request, { fetchImpl })).rejects.toThrow("account disabled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it("tries every enabled model in visible catalog order and keeps credentials separate", async () => {
    const first = { providerId: "openrouter", modelId: "jev-a" };
    const second = { providerId: "commandcode", modelId: "jev-b" };
    const third = { providerId: "typesafe", modelId: "jev-c" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: third, enabledModels: [third, second, first] });
    mocks.readState.mockReturnValue({ providerOrder: ["openrouter", "commandcode", "typesafe"], modelOrder: {} });
    mocks.resolve.mockImplementation(async (settings) => ({ baseUrl: `https://${settings.registeredModel.providerId}.example/v1`, model: settings.registeredModel.modelId, apiKey: `${settings.registeredModel.providerId}-key` }));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify(result)));
    await expect(evaluateTypeSafe(request, { fetchImpl, apiKey: "unrelated-key" })).resolves.toEqual(result);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter.example/v1/systemone", "https://commandcode.example/v1/systemone", "https://typesafe.example/v1/systemone",
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual(["Bearer openrouter-key", "Bearer commandcode-key", "Bearer typesafe-key"]);
    expect(mocks.recordUsage).toHaveBeenCalledWith(result.usage);
  });

  it("uses model order within one provider and never tries an unselected model", async () => {
    const first = { providerId: "openrouter", modelId: "jev-a", accountId: "one" };
    const second = { providerId: "openrouter", modelId: "jev-b", accountId: "one" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: first, enabledModels: [first, second] });
    mocks.readState.mockReturnValue({ providerOrder: ["one::openrouter"], modelOrder: { "one::openrouter": ["jev-b", "jev-a"] } });
    mocks.resolve.mockImplementation(async (settings) => ({ baseUrl: "https://openrouter.example/v1", model: settings.registeredModel.modelId, apiKey: "account-key" }));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify(result)));
    await expect(evaluateTypeSafe(request, { fetchImpl })).resolves.toEqual(result);
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body).model)).toEqual(["jev-b", "jev-a"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never resolves or sends state to an undetected reference, even when it is the primary selection", async () => {
    const missing = { providerId: "commandcode", modelId: "typesafe/jev" };
    const detected = { providerId: "typesafe", modelId: "jev-latest" };
    const settings = { ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: missing, enabledModels: [missing, detected] };
    mocks.readSettings.mockReturnValue(settings);
    mocks.readState.mockReturnValue({ providerOrder: ["commandcode", "typesafe"], modelOrder: {} });
    mocks.list.mockResolvedValue([{ ...detected, providerName: "TypeSafe", name: "Jev", baseUrl: "https://api.typesafe.ai/v1", source: "documented" }]);
    mocks.resolve.mockResolvedValue({ baseUrl: "https://api.typesafe.ai/v1", model: detected.modelId });
    const fetchImpl = respond();
    await expect(evaluateTypeSafe(request, { fetchImpl })).resolves.toEqual(result);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ ...settings, registeredModel: detected });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(settings.enabledModels).toEqual([missing, detected]);
  });

  it.each([false, true])("does not use unselected accounts when the registered selection is undetected (multiple=%s)", async (multiple) => {
    const ref = { providerId: "openrouter", modelId: "typesafe/jev", accountId: "missing" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: ref, ...(multiple ? { enabledModels: [ref] } : {}) });
    mocks.list.mockResolvedValue([{ ...ref, accountId: "other", providerName: "OpenRouter", name: "Jev", baseUrl: "https://example.test/v1", source: "catalog" }]);
    const fetchImpl = respond();
    await expect(evaluateTypeSafe(request, { fetchImpl })).rejects.toThrow("有効なJevモデルがありません");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the last detected failure when the saved fallback list ends with an undetected model", async () => {
    const detected = { providerId: "typesafe", modelId: "jev-latest" };
    const missing = { providerId: "commandcode", modelId: "typesafe/jev" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: detected, enabledModels: [detected, missing] });
    mocks.readState.mockReturnValue({ providerOrder: ["typesafe", "commandcode"], modelOrder: {} });
    mocks.list.mockResolvedValue([{ ...detected, providerName: "TypeSafe", name: "Jev", baseUrl: "https://api.typesafe.ai/v1", source: "documented" }]);
    mocks.resolve.mockResolvedValue({ baseUrl: "https://api.typesafe.ai/v1", model: detected.modelId });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(evaluateTypeSafe(request, { fetchImpl })).rejects.toThrow("Jev API error: 503");
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never sends state when catalog discovery fails", async () => {
    const ref = { providerId: "typesafe", modelId: "jev-latest" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: ref, enabledModels: [ref] });
    mocks.list.mockRejectedValue(new Error("catalog unavailable"));
    const fetchImpl = respond();
    await expect(evaluateTypeSafe(request, { fetchImpl })).rejects.toThrow("catalog unavailable");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips detected models marked as paused in the live catalog", async () => {
    const ref = { providerId: "typesafe", modelId: "jev-latest" };
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: ref });
    mocks.list.mockResolvedValue([{ ...ref, providerName: "TypeSafe", name: "Jev", baseUrl: "https://api.typesafe.ai/v1", source: "documented", providerEnabled: false }]);
    const fetchImpl = respond();
    await expect(evaluateTypeSafe(request, { fetchImpl })).rejects.toThrow("有効なJevモデルがありません");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back when the first model cannot resolve and reports the final failure", async () => {
    const refs = [{ providerId: "openrouter", modelId: "jev-a" }, { providerId: "typesafe", modelId: "jev-b" }];
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: refs[0], enabledModels: refs });
    mocks.resolve.mockRejectedValueOnce(new Error("account disabled")).mockResolvedValueOnce({ baseUrl: "https://typesafe.example/v1", model: "jev-b" });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(evaluateTypeSafe(request, { fetchImpl })).rejects.toThrow("Jev API error: 401");
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips selections under a disabled provider without surfacing their errors", async () => {
    const refs = [{ providerId: "openrouter", modelId: "jev-a", accountId: "one" }, { providerId: "typesafe", modelId: "jev-b" }];
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: refs[0], enabledModels: refs });
    mocks.readState.mockReturnValue({ providerOrder: [], modelOrder: {}, disabled: { "one::openrouter": true } });
    mocks.resolve.mockImplementation(async (settings) => ({ baseUrl: `https://${settings.registeredModel.providerId}.example/v1`, model: settings.registeredModel.modelId }));
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(evaluateTypeSafe(request, { fetchImpl })).rejects.toThrow("Jev API error: 401");
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["https://typesafe.example/v1/systemone"]);
    mocks.readState.mockReturnValue({ providerOrder: [], modelOrder: {}, disabled: { "one::openrouter": true, typesafe: true } });
    await expect(evaluateTypeSafe(request, { fetchImpl })).rejects.toThrow("有効なJevモデルがありません");
  });

  it("keeps integrated accounts together despite stale per-account provider order", async () => {
    const refs = [
      { providerId: "openrouter", modelId: "jev-a", accountId: "one" },
      { providerId: "openrouter", modelId: "jev-b", accountId: "two" },
      { providerId: "commandcode", modelId: "jev-a", accountId: "one" },
      { providerId: "commandcode", modelId: "jev-b", accountId: "two" },
    ];
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: refs[0], enabledModels: refs });
    mocks.readRouting.mockReturnValue({ modes: { openrouter: "integrated", commandcode: "integrated" } });
    mocks.readState.mockReturnValue({ providerOrder: ["one::openrouter", "one::commandcode", "two::openrouter", "two::commandcode"], modelOrder: {} });
    mocks.resolve.mockImplementation(async (settings) => ({ baseUrl: `https://${settings.registeredModel.providerId}-${settings.registeredModel.accountId}.example/v1`, model: settings.registeredModel.modelId }));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify(result)));
    await expect(evaluateTypeSafe(request, { fetchImpl })).resolves.toEqual(result);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter-one.example/v1/systemone", "https://openrouter-two.example/v1/systemone",
      "https://commandcode-one.example/v1/systemone", "https://commandcode-two.example/v1/systemone",
    ]);
  });

  it("does not fall back after caller cancellation", async () => {
    const refs = [{ providerId: "openrouter", modelId: "jev-a" }, { providerId: "typesafe", modelId: "jev-b" }];
    mocks.readSettings.mockReturnValue({ ...DEFAULT_JEV_MODEL_SETTINGS, provider: "registered", registeredModel: refs[0], enabledModels: refs });
    mocks.resolve.mockResolvedValue({ baseUrl: "https://example.test/v1", model: "jev-a" });
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error("cancelled");
    });
    await expect(evaluateTypeSafe(request, { fetchImpl, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    expect(mocks.recordLatency).not.toHaveBeenCalled();
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
