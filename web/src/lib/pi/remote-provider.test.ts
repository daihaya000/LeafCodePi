import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  modelRows,
  registerRemoteProvider,
  syncRemoteProvider,
  REMOTE_PROVIDER_BASE,
  REMOTE_PROVIDER_API_KEY_ENV,
} from "./remote-provider";

beforeEach(() => vi.stubEnv(REMOTE_PROVIDER_API_KEY_ENV, "test-api-key"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("remote-provider", () => {
  it("converts the OpenAI-compatible model catalog", () => {
    const [model] = modelRows({
      data: [{ id: "Avesed/Qwen3.8-27B-INT4-W4A16", max_model_len: 65_536 }],
    });
    expect(model).toMatchObject({
      id: "Avesed/Qwen3.8-27B-INT4-W4A16",
      provider: "z390-s01",
      baseUrl: REMOTE_PROVIDER_BASE,
      contextWindow: 131_072,
      reasoning: true,
    });
  });

  it("refreshes the registered catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: "updated-model" }] }), {
          status: 200,
        }),
      ),
    );
    const registerProvider = vi.fn();
    await syncRemoteProvider({
      getProvider: () => undefined,
      registerProvider,
    });
    expect(registerProvider).toHaveBeenCalledWith(
      "z390-s01",
      expect.objectContaining({
        models: [expect.objectContaining({ id: "updated-model" })],
      }),
    );
  });

  it("registers the endpoint and discovered models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: "remote-model" }] }), {
          status: 200,
        }),
      ),
    );
    const registerProvider = vi.fn();
    await registerRemoteProvider({
      getProvider: () => undefined,
      registerProvider,
    });
    expect(registerProvider).toHaveBeenCalledWith(
      "z390-s01",
      expect.objectContaining({
        name: "Z390-S01",
        baseUrl: REMOTE_PROVIDER_BASE,
        models: [expect.objectContaining({ id: "remote-model" })],
      }),
    );
  });
});
