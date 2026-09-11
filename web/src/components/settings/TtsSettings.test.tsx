// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsSettings } from "./TtsSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

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
        { url: "http://127.0.0.1:10101", voice: "888753760" },
        "PATCH",
      );
    });
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
