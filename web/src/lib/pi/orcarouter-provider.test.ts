import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORCAROUTER_API_KEY_ENV,
  ORCAROUTER_BASE_URL,
  ORCAROUTER_PROVIDER_ID,
  isOrcaRouterReasoningModel,
  parseOrcaRouterModelRows,
  registerOrcaRouterProvider,
} from "./orcarouter-provider";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("orcarouter-provider", () => {
  it("converts the OpenAI-compatible model catalog", () => {
    const rows = parseOrcaRouterModelRows({
      data: [
        {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o mini",
          supported_endpoint_types: ["openai"],
          context_length: 64_000,
          max_completion_tokens: 4_096,
          architecture: { input_modalities: ["text", "image"] },
          pricing: { prompt: "0.000001", completion_per_million: "2" },
        },
        {
          id: "openai/text-embedding",
          supported_endpoint_types: ["embeddings"],
        },
        {
          id: "orcarouter/auto",
          supported_endpoint_types: ["openai"],
        }
      ]
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "openai/gpt-4o-mini",
      name: "GPT-4o mini",
      api: "openai-completions",
      baseUrl: ORCAROUTER_BASE_URL,
      input: ["text", "image"],
      contextWindow: 64_000,
      maxTokens: 4_096,
      cost: { input: 0.000001, output: 0.000002 },
    });
    expect(rows[1]).toMatchObject({
      id: "orcarouter/auto",
      name: "orcarouter/auto",
    });
  });

  it("infers reasoning models from provider-prefixed IDs", () => {
    expect(isOrcaRouterReasoningModel("openai/o3-mini")).toBe(true);
    expect(isOrcaRouterReasoningModel("deepseek/deepseek-r1")).toBe(true);
    expect(isOrcaRouterReasoningModel("openai/gpt-4o-mini")).toBe(false);
  });

  it("registers API-key auth and uses stored account keys for discovery", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "openai/gpt-4o-mini" }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const registerProvider = vi.fn();
    const refresh = vi.fn(async () => undefined);

    await registerOrcaRouterProvider({
      getProvider: () => undefined,
      registerProvider,
      refresh,
    });

    expect(registerProvider).toHaveBeenCalledWith(
      ORCAROUTER_PROVIDER_ID,
      expect.objectContaining({
        name: "OrcaRouter",
        baseUrl: ORCAROUTER_BASE_URL,
        apiKey: `$${ORCAROUTER_API_KEY_ENV}`,
      }),
    );
    const config = registerProvider.mock.calls[0][1] as {
      refreshModels: (context: unknown) => Promise<unknown>;
    };
    await config.refreshModels({
      allowNetwork: true,
      signal: new AbortController().signal,
      credential: { type: "api_key", key: "stored-key" },
    });
    expect(fetch).toHaveBeenCalledWith(
      `${ORCAROUTER_BASE_URL}/models`,
      expect.objectContaining({
        headers: {
          Authorization: "Bearer stored-key",
          Accept: "application/json",
        },
      }),
    );
  });

  it("does not use ambient keys in an account runtime", async () => {
    vi.stubEnv(ORCAROUTER_API_KEY_ENV, "ambient-key");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const registerProvider = vi.fn();

    await registerOrcaRouterProvider(
      {
        getProvider: () => undefined,
        registerProvider,
        refresh: vi.fn(async () => undefined),
      },
      {
        key: "account:one",
        kind: "account",
        accountId: "one",
        accountLabel: "One",
        authPath: "C:\\auth.json",
      },
    );

    const config = registerProvider.mock.calls[0][1] as {
      apiKey: string;
      refreshModels: (context: unknown) => Promise<unknown>;
    };
    expect(config.apiKey).toBe("$LEAFCODEPI_ORCAROUTER_ACCOUNT_API_KEY");
    await expect(
      config.refreshModels({
        allowNetwork: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
