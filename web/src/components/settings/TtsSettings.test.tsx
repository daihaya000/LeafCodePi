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
    getJson.mockResolvedValue({
      enabled: false,
      voice: "Microsoft Haruka Desktop",
      rate: 0,
      url: "",
    });
    sendJson.mockImplementation(async (_path: string, body: Record<string, unknown>) => ({
      enabled: body.enabled === true,
      voice: typeof body.voice === "string" ? body.voice : "Microsoft Haruka Desktop",
      rate: typeof body.rate === "number" ? body.rate : 0,
      url: typeof body.url === "string" ? body.url : "",
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it("loads TTS settings and toggles enabled", async () => {
    render(<TtsSettings />);

    const toggle = await screen.findByRole("switch", { name: "読み上げを有効にする" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(getJson).toHaveBeenCalledWith("/api/settings/tts");
    expect(screen.getByDisplayValue("Microsoft Haruka Desktop")).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith("/api/settings/tts", { enabled: true }, "PATCH");
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("saves HTTP url on blur", async () => {
    render(<TtsSettings />);
    const url = await screen.findByLabelText("TTS HTTP URL");
    fireEvent.change(url, { target: { value: "http://127.0.0.1:8080/v1/audio/speech" } });
    fireEvent.blur(url);
    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/tts",
        { url: "http://127.0.0.1:8080/v1/audio/speech" },
        "PATCH",
      );
    });
  });

  it("keeps controls disabled when the initial fetch fails", async () => {
    getJson.mockRejectedValue(new Error("取得失敗"));
    render(<TtsSettings />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("取得失敗");
    });
    expect(screen.getByRole("switch", { name: "読み上げを有効にする" })).toHaveProperty("disabled", true);
    expect(sendJson).not.toHaveBeenCalled();
  });
});
