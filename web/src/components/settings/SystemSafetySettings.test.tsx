// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemSafetySettings } from "./SystemSafetySettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("SystemSafetySettings", () => {
  beforeEach(() => {
    getJson.mockReset();
    sendJson.mockReset();
    getJson.mockResolvedValue({ level: "standard", systemSafety: true });
    sendJson.mockResolvedValue({ level: "low", systemSafety: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the current level and can change intensity with the slider", async () => {
    render(<SystemSafetySettings />);

    const slider = await screen.findByRole("slider", { name: "システム安全ガードの度合い" });
    await waitFor(() => expect((slider as HTMLInputElement).value).toBe("2"));
    expect(slider.getAttribute("aria-valuetext")).toBe("標準");
    expect(screen.getByText(/git show など日常の開発操作は確認なし/)).toBeTruthy();

    fireEvent.change(slider, { target: { value: "1" } });

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/system-safety",
        { level: "low" },
        "PATCH",
      );
    });
    await waitFor(() => expect((slider as HTMLInputElement).value).toBe("1"));
    expect(slider.getAttribute("aria-valuetext")).toBe("軽め");
  });

  it("rolls back the slider when saving fails", async () => {
    sendJson.mockRejectedValue(new Error("保存失敗"));
    render(<SystemSafetySettings />);

    const slider = await screen.findByRole("slider", { name: "システム安全ガードの度合い" });
    await waitFor(() => expect((slider as HTMLInputElement).value).toBe("2"));
    fireEvent.change(slider, { target: { value: "0" } });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("保存失敗");
    });
    expect((slider as HTMLInputElement).value).toBe("2");
  });
});
