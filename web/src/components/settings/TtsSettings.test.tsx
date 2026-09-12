// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsSettings } from "./TtsSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson, apiUrl: (path: string) => path }));

describe("TtsSettings", () => {
  beforeEach(() => {
    getJson.mockReset();
    sendJson.mockReset();
    getJson.mockImplementation(async (path: string) => {
      if (path === "/api/settings/tts/server") return { running: false };
      return {
        enabled: false,
        voice: "",
        rate: 0,
        url: "",
      };
    });
    sendJson.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path === "/api/settings/tts/server") return { started: true };
      return {
        enabled: typeof body.enabled === "boolean" ? body.enabled : false,
        voice: typeof body.voice === "string" ? body.voice : "",
        rate: typeof body.rate === "number" ? body.rate : 0,
        url: typeof body.url === "string" ? body.url : "",
      };
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("loads TTS settings and toggles enabled", async () => {
    render(<TtsSettings />);

    const toggle = await screen.findByRole("switch", { name: "読み上げを有効にする" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(getJson).toHaveBeenCalledWith("/api/settings/tts");
    expect(screen.getByRole("button", { name: "TTS バックエンド" }).textContent).toContain("Windows SAPI");

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith("/api/settings/tts", { enabled: true }, "PATCH");
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("switches backend presets via the dropdown", async () => {
    render(<TtsSettings />);
    const trigger = await screen.findByRole("button", { name: "TTS バックエンド" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "AivisSpeech" }));
    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/tts",
        { url: "http://127.0.0.1:10101", voice: "1455757728" },
        "PATCH",
      );
    });
  });

  it("plays a test utterance with the synthesize API", async () => {
    const play = vi.fn(async () => undefined);
    vi.stubGlobal("Audio", class {
      onended: (() => void) | null = null;
      playbackRate = 1;
      volume = 1;
      play = play;
      pause = vi.fn();
    });
    const fetchMock = vi.fn(async () => new Response(Buffer.from([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<TtsSettings />);
      fireEvent.click(await screen.findByRole("button", { name: "テスト再生" }));
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ text: "読み上げのテストです。" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the synthesize error instead of playing", async () => {
    vi.stubGlobal("Audio", class {
      play = vi.fn(async () => undefined);
      pause = vi.fn();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "合成エンジンが未設定です" }), { status: 400 })),
    );
    try {
      render(<TtsSettings />);
      fireEvent.click(await screen.findByRole("button", { name: "テスト再生" }));
      await waitFor(() => {
        expect(screen.getByRole("alert").textContent).toContain("合成エンジンが未設定です");
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps controls disabled when the initial fetch fails", async () => {
    getJson.mockImplementation(async (path: string) => {
      if (path === "/api/settings/tts/server") return { running: false };
      throw new Error("取得失敗");
    });
    render(<TtsSettings />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("取得失敗");
    });
    expect(screen.getByRole("switch", { name: "読み上げを有効にする" })).toHaveProperty("disabled", true);
    expect(sendJson).not.toHaveBeenCalled();
  });
});
