import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  OPENDESIGN_API_KEY_ENV,
  OPENDESIGN_BASE_URL,
  createOpenDesignProvider,
  fetchOpenDesignModelRows,
  parseOpenDesignModelRows,
  registerOpenDesignProvider,
} from "@backend-runtime/lib/pi/opendesign-provider";
import { setProviderBaseUrl } from "@/lib/provider-endpoints";
import { isAccountProviderId } from "@/lib/accounts";
import { isAccountRoutingProvider } from "@/lib/provider-routing";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isolatedDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-opendesign-"));
  dirs.push(dir);
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", dir);
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    credential: { type: "api_key", key: "fixture-key" },
    publish: vi.fn(async (publication: ModelsPublication) => {
      publication.update?.();
      return true;
    }),
    ...overrides,
  };
}

function mockCatalog() {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "fixture-chat" }] })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("opendesign-provider", () => {
  it("parses plain OpenAI model IDs, removes duplicates and non-chat models", () => {
    const models = parseOpenDesignModelRows({ data: [
      { id: "  fixture-chat  " }, { id: "fixture-chat" }, { id: 1 }, null,
      { id: "text-embedding-3" }, { id: "image-model", type: "image" },
      { id: "other-protocol", supported_endpoint_types: ["embeddings"] },
      { id: "fixture-vision", name: "Vision", reasoning: true,
        context_length: 4096, max_completion_tokens: 8192,
        architecture: { input_modalities: ["text", "image"] } },
    ] });
    expect(models.map((model) => model.id)).toEqual(["fixture-chat", "fixture-vision"]);
    expect(models[0]).toMatchObject({ provider: "opendesign", api: "openai-completions", baseUrl: OPENDESIGN_BASE_URL });
    expect(models[1]).toMatchObject({ name: "Vision", contextWindow: 4096, maxTokens: 4096, input: ["text", "image"], reasoning: true });
    expect(parseOpenDesignModelRows(null)).toEqual([]);
    expect(parseOpenDesignModelRows({ data: "invalid" })).toEqual([]);
    expect(parseOpenDesignModelRows({ data: [{ id: "tiny", context_length: 0.5 }] })[0].contextWindow).toBe(128000);
  });

  it("fetches an authenticated live catalog with cancellation", async () => {
    const fetch = mockCatalog();
    const signal = new AbortController().signal;
    await fetchOpenDesignModelRows("fixture-key", { baseUrl: "https://fixture.example/v1/", signal });
    expect(fetch).toHaveBeenCalledWith("https://fixture.example/v1/models", expect.objectContaining({
      headers: { Authorization: "Bearer fixture-key", Accept: "application/json" }, signal,
    }));
  });

  it("rejects invalid/empty catalogs and does not echo upstream secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fixture-secret", { status: 401 })));
    await expect(fetchOpenDesignModelRows("fixture-key")).rejects.toThrow("(401)");
    await expect(fetchOpenDesignModelRows("fixture-key")).rejects.not.toThrow("fixture-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json")));
    await expect(fetchOpenDesignModelRows("fixture-key")).rejects.toThrow("解析");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }))));
    await expect(fetchOpenDesignModelRows("fixture-key")).rejects.toThrow("利用可能なモデル");
  });

  it("registers once, enables account routing, and refreshes the catalog", async () => {
    isolatedDataDir();
    const providers = new Map<string, unknown>();
    const runtime = {
      getProvider: (id: string) => providers.get(id),
      registerNativeProvider: vi.fn((provider: ReturnType<typeof createOpenDesignProvider>) => providers.set(provider.id, provider)),
      refresh: vi.fn(async () => undefined),
    };
    await registerOpenDesignProvider(runtime);
    await registerOpenDesignProvider(runtime);
    expect(runtime.registerNativeProvider).toHaveBeenCalledTimes(1);
    expect(runtime.refresh).toHaveBeenCalledWith(expect.objectContaining({ providers: ["opendesign"] }));
    expect(isAccountProviderId("opendesign")).toBe(true);
    expect(isAccountRoutingProvider("opendesign")).toBe(true);
  });

  it("validates login before returning credentials and links the key console", async () => {
    isolatedDataDir();
    mockCatalog();
    const provider = createOpenDesignProvider();
    const notify = vi.fn();
    const prompt = vi.fn(async () => "  fixture-key  ");
    const interaction = { notify, prompt, signal: new AbortController().signal };
    await expect(provider.auth.apiKey!.login!(interaction)).resolves.toEqual({ type: "api_key", key: "fixture-key" });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ links: [{ url: "https://open-design.ai/cloud/api-keys", label: "API keys" }] }));
    prompt.mockResolvedValueOnce(" ");
    await expect(provider.auth.apiKey!.login!(interaction)).rejects.toThrow("API キーが必要");
  });

  it("never resolves ambient credentials for an account; stored keys still work", async () => {
    isolatedDataDir();
    vi.stubEnv(OPENDESIGN_API_KEY_ENV, "ambient-key");
    const fetch = mockCatalog();
    const provider = createOpenDesignProvider({ kind: "account", key: "account:one", accountId: "one", accountLabel: "One", authPath: "fixture-auth.json" });
    const ctx = { env: vi.fn(async () => "ambient-key") };
    const signal = new AbortController().signal;
    const auth = provider.auth.apiKey!;
    await expect(auth.check!({ ctx, signal } as never)).resolves.toBeUndefined();
    await expect(auth.resolve({ ctx, signal } as never)).resolves.toBeUndefined();
    await provider.refreshModels!(refreshContext({ credential: undefined }));
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.env).not.toHaveBeenCalled();
    await expect(auth.resolve({ ctx, signal, credential: { type: "api_key", key: "stored-key" } } as never)).resolves.toMatchObject({ auth: { apiKey: "stored-key" } });
    await provider.refreshModels!(refreshContext({ credential: { type: "api_key", key: "stored-key" } }));
    expect(fetch).toHaveBeenCalledWith(`${OPENDESIGN_BASE_URL}/models`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer stored-key" }) }));
  });

  it("uses the endpoint override for discovery and auth and retains cached models offline", async () => {
    isolatedDataDir();
    setProviderBaseUrl("opendesign", "https://fixture.example/v1/");
    const fetch = mockCatalog();
    const provider = createOpenDesignProvider();
    await expect(provider.auth.apiKey!.resolve({
      ctx: { env: async () => undefined },
      credential: { type: "api_key", key: "fixture-key" },
      signal: new AbortController().signal,
    } as never)).resolves.toMatchObject({ auth: { apiKey: "fixture-key", baseUrl: "https://fixture.example/v1" } });
    await provider.refreshModels!(refreshContext());
    expect(provider.getModels()[0].baseUrl).toBe("https://fixture.example/v1");
    const cached = { models: [...provider.getModels()], checkedAt: Date.now() };
    fetch.mockClear();
    await provider.refreshModels!(refreshContext({ allowNetwork: false, stored: cached }));
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(provider.refreshModels!(refreshContext({ stored: cached }))).rejects.toThrow("offline");
    expect(provider.getModels()[0].id).toBe("fixture-chat");
    const signal = AbortSignal.abort();
    await provider.refreshModels!(refreshContext({ signal, stored: cached }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
