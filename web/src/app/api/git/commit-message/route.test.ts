import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn<(key: string) => string | null>(),
  completeModelText: vi.fn(),
}));

vi.mock("@/lib/pi/web-settings", () => ({ getSetting: mocks.getSetting }));
vi.mock("@/lib/pi/harness", () => ({ completeModelText: mocks.completeModelText }));

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/git/commit-message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const file = {
  path: "src/app.ts",
  additions: 4,
  deletions: 0,
  hunks: [{ header: "@@", lines: [{ t: "+", text: "added" }] }],
};

describe("/api/git/commit-message", () => {
  beforeEach(() => {
    mocks.getSetting.mockReset();
    mocks.getSetting.mockReturnValue(null);
    mocks.completeModelText.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("skips AI for a simple single-file change", async () => {
    const response = await POST(
      request({ directory: "C:\\repo-simple", model: { providerID: "llama-server", modelID: "local-model" }, files: [
        { ...file, additions: 1 },
      ] }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "更新 app.ts",
      source: "fallback",
      model: null,
    });
    expect(mocks.completeModelText).not.toHaveBeenCalled();
  });

  it("uses direct generation when the selected model is supported", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[1].content).toContain("src/app.ts");
      expect(body.messages[1].content).toContain("+added");
      return new Response(JSON.stringify({ choices: [{ message: { content: "追加 app.ts\n" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({
        directory: "C:\\repo",
        model: { providerID: "llama-server", modelID: "local-model" },
        files: [file],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "追加 app.ts",
      source: "direct",
      model: { providerID: "llama-server", modelID: "local-model" },
    });
  });

  it("uses the persisted generation model without reasoning", async () => {
    mocks.getSetting.mockImplementation((key: string) => {
      if (key === "generation-model") return "openrouter::stealth/ox-alpha";
      if (key === "generation-model-effort") return "low";
      return null;
    });
    mocks.completeModelText.mockResolvedValue("変更内容を明確化");

    const response = await POST(request({ directory: "C:\\repo", files: [file] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "変更内容を明確化",
      source: "direct",
      model: { providerID: "openrouter", modelID: "stealth/ox-alpha" },
    });
    expect(mocks.completeModelText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerID: "openrouter",
        modelID: "stealth/ox-alpha",
        maxTokens: 64,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reports direct-generation failure while keeping the deterministic fallback", async () => {
    mocks.getSetting.mockImplementation((key: string) =>
      key === "generation-model" ? "openrouter::stealth/ox-alpha" : null,
    );
    mocks.completeModelText.mockRejectedValue(new Error("429: temporarily rate-limited"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await POST(request({ directory: "C:\\repo-failure", files: [file] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "更新 app.ts",
      source: "fallback",
      model: null,
      warning:
        "AI生成に失敗したため、ファイル情報から生成しました: 直接生成に失敗しました: 429: temporarily rate-limited",
    });
  });

  it("tries the configured fallback model without reasoning before the deterministic fallback", async () => {
    mocks.getSetting.mockImplementation((key: string) => {
      if (key === "generation-model") return "openrouter::primary";
      if (key === "generation-model-effort") return "low";
      if (key === "generation-fallback-model") return "ollama-cloud::fallback";
      if (key === "generation-fallback-model-effort") return "high";
      return null;
    });
    mocks.completeModelText
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockResolvedValueOnce("フォールバックでコミット");

    const response = await POST(request({ directory: "C:\\repo-fallback", files: [file] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "フォールバックでコミット",
      source: "direct",
      model: { providerID: "ollama-cloud", modelID: "fallback" },
    });
    expect(mocks.completeModelText).toHaveBeenCalledTimes(2);
    expect(mocks.completeModelText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerID: "ollama-cloud",
        modelID: "fallback",
        maxTokens: 64,
      }),
    );
  });
});
