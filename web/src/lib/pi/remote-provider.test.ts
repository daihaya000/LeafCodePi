import { mkdtempSync, rmSync } from "node:fs";
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

  it("marks LeafModel as a reasoning model so effort options are available", () => {
    expect(modelRows({ data: [{ id: "LeafModel" }] })[0]).toMatchObject({
      reasoning: true,
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
