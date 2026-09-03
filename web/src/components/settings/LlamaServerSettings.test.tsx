// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLAMA_SERVER_SETTINGS,
  LLAMA_MODEL_PRESETS,
} from "@/lib/llama-server-settings";
import { LlamaServerSettings } from "./LlamaServerSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("LlamaServerSettings", () => {
  beforeEach(() => {
    getJson.mockImplementation((path: string) => {
      if (path === "/api/settings/llama-server-config") {
        return Promise.resolve({ parsed: { ...DEFAULT_LLAMA_SERVER_SETTINGS } });
      }
      if (path === "/api/llama-server/models") {
        return Promise.resolve({ models: [], defaultModel: null, dir: null });
      }
      if (path === "/api/llama-server/status") {
        return Promise.resolve({
          running: false,
          pid: null,
          listeningPids: [],
          health: null,
        });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    sendJson.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("非表示中は状態をポーリングせず、再表示時に取得する", async () => {
    const view = render(<LlamaServerSettings active={false} />);

    await waitFor(() => {
      expect(getJson).toHaveBeenCalledWith("/api/settings/llama-server-config");
    });
    expect(getJson).not.toHaveBeenCalledWith("/api/llama-server/status");

    view.rerender(<LlamaServerSettings active />);

    await waitFor(() => {
      expect(getJson).toHaveBeenCalledWith("/api/llama-server/status");
    });
  });

  it("保留中の設定をアンマウント時に保存する", async () => {
    const view = render(<LlamaServerSettings />);
    const family = await screen.findByLabelText("使用するモデル");
    const preset = LLAMA_MODEL_PRESETS[0]!;

    fireEvent.change(family, { target: { value: preset.key } });
    view.unmount();

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/llama-server-config",
        { value: expect.any(String) },
        "PUT",
      );
    });
    const body = sendJson.mock.calls[0]?.[1] as { value: string };
    expect(JSON.parse(body.value)).toMatchObject(preset.settings);
  });
});
