import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));
const accounts = vi.hoisted(() => ({ listAccounts: vi.fn() }));

vi.mock("@/lib/pi/web-settings", () => ({
  MAX_SETTING_VALUE_CHARS: 4096,
  getSetting: settings.getSetting,
  setSetting: settings.setSetting,
}));
vi.mock("@/lib/accounts", () => ({ listAccounts: accounts.listAccounts }));

import { GET, PUT } from "./route";

function request(key: string, body: unknown): NextRequest {
  return new NextRequest(`http://127.0.0.1:3010/api/settings/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/settings/[key]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accounts.listAccounts.mockReturnValue([]);
    settings.getSetting.mockReturnValue("llama-server::local-model");
  });

  it("reads and writes the generation model", async () => {
    const getResponse = await GET(new NextRequest("http://127.0.0.1:3010/api/settings/generation-model"), {
      params: Promise.resolve({ key: "generation-model" }),
    });
    expect(await getResponse.json()).toEqual({ value: "llama-server::local-model" });

    const putResponse = await PUT(
      request("generation-model", { value: "ollama-cloud::qwen3" }),
      { params: Promise.resolve({ key: "generation-model" }) },
    );
    expect(putResponse.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith("generation-model", "ollama-cloud::qwen3");
  });

  it("rejects malformed generation model keys", async () => {
    const response = await PUT(
      request("generation-model", { value: "not-a-model" }),
      { params: Promise.resolve({ key: "generation-model" }) },
    );
    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("accepts an API or subscription provider model", async () => {
    const response = await PUT(
      request("generation-model", { value: "anthropic::claude-sonnet" }),
      { params: Promise.resolve({ key: "generation-model" }) },
    );
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(
      "generation-model",
      "anthropic::claude-sonnet",
    );
  });

  it("preserves a known account prefix when persisting a generation model", async () => {
    accounts.listAccounts.mockReturnValue([{ id: "acc-1" }]);
    const response = await PUT(
      request("generation-model", { value: "acc-1::anthropic::claude-sonnet" }),
      { params: Promise.resolve({ key: "generation-model" }) },
    );
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(
      "generation-model",
      "acc-1::anthropic::claude-sonnet",
    );
  });

  it("accepts and persists a generation-model effort", async () => {
    const response = await PUT(
      request("generation-model-effort", { value: "high" }),
      { params: Promise.resolve({ key: "generation-model-effort" }) },
    );
    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith("generation-model-effort", "high");
  });

  it("rejects an invalid generation-model effort", async () => {
    const response = await PUT(
      request("generation-model-effort", { value: "turbo" }),
      { params: Promise.resolve({ key: "generation-model-effort" }) },
    );
    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("accepts and persists the fallback model and effort", async () => {
    const modelResponse = await PUT(
      request("generation-fallback-model", { value: "ollama-cloud::qwen3" }),
      { params: Promise.resolve({ key: "generation-fallback-model" }) },
    );
    const effortResponse = await PUT(
      request("generation-fallback-model-effort", { value: "low" }),
      { params: Promise.resolve({ key: "generation-fallback-model-effort" }) },
    );

    expect(modelResponse.status).toBe(200);
    expect(effortResponse.status).toBe(200);
    expect(settings.setSetting).toHaveBeenNthCalledWith(
      1,
      "generation-fallback-model",
      "ollama-cloud::qwen3",
    );
    expect(settings.setSetting).toHaveBeenNthCalledWith(
      2,
      "generation-fallback-model-effort",
      "low",
    );
  });

  it("rejects an invalid fallback effort", async () => {
    const response = await PUT(
      request("generation-fallback-model-effort", { value: "turbo" }),
      { params: Promise.resolve({ key: "generation-fallback-model-effort" }) },
    );

    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("accepts valid Auto settings and normalizes route overrides", async () => {
    const modeResponse = await PUT(
      request("auto-optimize", { value: "intelligence" }),
      { params: Promise.resolve({ key: "auto-optimize" }) },
    );
    const routeResponse = await PUT(
      request("auto-route-overrides", {
        value: JSON.stringify({
          light: { costOrder: ["cheap", "mid"] },
        }),
      }),
      { params: Promise.resolve({ key: "auto-route-overrides" }) },
    );

    expect(modeResponse.status).toBe(200);
    expect(routeResponse.status).toBe(200);
    expect(settings.setSetting).toHaveBeenNthCalledWith(
      1,
      "auto-optimize",
      "intelligence",
    );
    expect(settings.setSetting).toHaveBeenNthCalledWith(
      2,
      "auto-route-overrides",
      JSON.stringify({
        version: 2,
        modes: {
          cost: {
            light: {
              candidates: [
                { kind: "cost", cost: "cheap" },
                { kind: "cost", cost: "mid" },
              ],
            },
          },
          balanced: {
            light: {
              candidates: [
                { kind: "cost", cost: "cheap" },
                { kind: "cost", cost: "mid" },
              ],
            },
          },
          intelligence: {
            light: {
              candidates: [
                { kind: "cost", cost: "cheap" },
                { kind: "cost", cost: "mid" },
              ],
            },
          },
        },
      }),
    );
  });

  it("accepts and persists the Auto agent selector prompt", async () => {
    const response = await PUT(
      request("auto-agent-prompt", { value: "レビューは reviewer を優先" }),
      { params: Promise.resolve({ key: "auto-agent-prompt" }) },
    );

    expect(response.status).toBe(200);
    expect(settings.setSetting).toHaveBeenCalledWith(
      "auto-agent-prompt",
      "レビューは reviewer を優先",
    );
  });

  it("rejects invalid Auto settings and clears the show-model setting", async () => {
    const invalidMode = await PUT(
      request("auto-optimize", { value: "turbo" }),
      { params: Promise.resolve({ key: "auto-optimize" }) },
    );
    const invalidShowModel = await PUT(
      request("auto-show-model", { value: "true" }),
      { params: Promise.resolve({ key: "auto-show-model" }) },
    );
    const clearShowModel = await PUT(
      request("auto-show-model", { value: "" }),
      { params: Promise.resolve({ key: "auto-show-model" }) },
    );

    expect(invalidMode.status).toBe(400);
    expect(await invalidMode.json()).toEqual({
      error: "auto-optimize must be cost, balanced or intelligence",
    });
    expect(invalidShowModel.status).toBe(400);
    expect(clearShowModel.status).toBe(200);
    expect(settings.setSetting).toHaveBeenLastCalledWith("auto-show-model", null);
  });
});
