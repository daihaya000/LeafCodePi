import { afterEach, describe, expect, it, vi } from "vitest";
import {
  modelRows,
  registerRemoteProvider,
  REMOTE_PROVIDER_BASE,
} from "./remote-provider";

afterEach(() => vi.unstubAllGlobals());

describe("remote-provider", () => {
  it("converts the OpenAI-compatible model catalog", () => {
    const [model] = modelRows({
      data: [{ id: "Avesed/Qwen3.8-27B-INT4-W4A16", max_model_len: 65_536 }],
    });
    expect(model).toMatchObject({
      id: "Avesed/Qwen3.8-27B-INT4-W4A16",
      provider: "remote-vllm",
      baseUrl: REMOTE_PROVIDER_BASE,
      contextWindow: 65_536,
      reasoning: true,
    });
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
      "remote-vllm",
      expect.objectContaining({
        name: "Remote vLLM",
        baseUrl: REMOTE_PROVIDER_BASE,
        models: [expect.objectContaining({ id: "remote-model" })],
      }),
    );
  });
});
