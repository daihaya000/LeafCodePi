import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProviderBaseUrl } from "@/lib/provider-endpoints";
import {
  modelRows,
  registerRemoteProvider,
  syncRemoteProvider,
  REMOTE_PROVIDER_BASE,
  REMOTE_PROVIDER_API_KEY_ENV,
} from "./remote-provider";

const dirs: string[] = [];

beforeEach(() => vi.stubEnv(REMOTE_PROVIDER_API_KEY_ENV, "test-api-key"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("remote-provider", () => {
  it("uses the renamed LeafCodeCloud credentials", () => {
    expect(REMOTE_PROVIDER_API_KEY_ENV).toBe("LEAFCODECLOUD_API_KEY");
  });

  it("keeps LeafModel reasoning while following provider image capability", () => {
    expect(
      modelRows({ data: [{ id: "LeafModel", supports_image_input: false }] })[0],
    ).toMatchObject({
      reasoning: true,
      input: ["text"],
    });
    expect(
      modelRows({ data: [{ id: "LeafModel", supports_image_input: true }] })[0],
    ).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
    });
  });

  it("converts the OpenAI-compatible model catalog", () => {
    const [model] = modelRows({
      data: [{ id: "other-model", max_model_len: 65_536 }],
    });
    expect(model).toMatchObject({
      id: "other-model",
      provider: "leafcodecloud",
      baseUrl: REMOTE_PROVIDER_BASE,
      contextWindow: 131_072,
      reasoning: false,
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
      "leafcodecloud",
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
      "leafcodecloud",
      expect.objectContaining({
        name: "LeafCodeCloud",
        baseUrl: REMOTE_PROVIDER_BASE,
        models: [expect.objectContaining({ id: "remote-model" })],
      }),
    );
  });

  it("prefers ~/.pi/agent/auth.json over the env API key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-rp-"));
    dirs.push(dir);
    const agentDir = join(dir, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv(REMOTE_PROVIDER_API_KEY_ENV, "env-key");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify(
        { leafcodecloud: { type: "api_key", key: "auth-key" } },
        null,
        2,
      ),
    );

    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "auth-model" }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const registerProvider = vi.fn();

    await syncRemoteProvider({
      getProvider: () => undefined,
      registerProvider,
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/models"),
      expect.objectContaining({
        headers: { Authorization: "Bearer auth-key" },
      }),
    );
    expect(registerProvider).toHaveBeenCalledWith(
      "leafcodecloud",
      expect.objectContaining({
        models: [expect.objectContaining({ id: "auth-model" })],
      }),
    );
  });

  it("uses the saved base URL for discovery and registration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-rp-"));
    dirs.push(dir);
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", dir);
    setProviderBaseUrl("leafcodecloud", "https://custom.example/v1/");
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "custom-model" }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const registerProvider = vi.fn();

    await syncRemoteProvider({
      getProvider: () => undefined,
      registerProvider,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://custom.example/v1/models",
      expect.any(Object),
    );
    expect(registerProvider).toHaveBeenCalledWith(
      "leafcodecloud",
      expect.objectContaining({
        baseUrl: "https://custom.example/v1",
        models: [expect.objectContaining({ id: "custom-model" })],
      }),
    );
  });

  it("keeps the registered URL until the runtime is recreated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-rp-"));
    dirs.push(dir);
    vi.stubEnv("LEAFCODE_PI_DATA_DIR", dir);
    setProviderBaseUrl("leafcodecloud", "https://custom.example/v1");
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "current-model" }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const registerProvider = vi.fn();

    await syncRemoteProvider({
      getProvider: () => ({ baseUrl: REMOTE_PROVIDER_BASE }),
      registerProvider,
    });

    expect(fetch).toHaveBeenCalledWith(
      `${REMOTE_PROVIDER_BASE}/models`,
      expect.any(Object),
    );
    expect(registerProvider).toHaveBeenCalledWith(
      "leafcodecloud",
      expect.objectContaining({ baseUrl: REMOTE_PROVIDER_BASE }),
    );
  });
});
