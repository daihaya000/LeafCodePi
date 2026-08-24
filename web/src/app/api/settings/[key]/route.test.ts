import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("@/lib/pi/web-settings", () => ({
  MAX_SETTING_VALUE_CHARS: 4096,
  getSetting: settings.getSetting,
  setSetting: settings.setSetting,
}));

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

  it("rejects providers unsupported by direct generation", async () => {
    const response = await PUT(
      request("generation-model", { value: "cursor::subscription-model" }),
      { params: Promise.resolve({ key: "generation-model" }) },
    );
    expect(response.status).toBe(400);
    expect(settings.setSetting).not.toHaveBeenCalled();
  });
});
