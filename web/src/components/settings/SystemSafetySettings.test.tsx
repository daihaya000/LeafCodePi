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
    getJson.mockResolvedValue({ systemSafety: true });
    sendJson.mockResolvedValue({ systemSafety: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the current setting and can disable system safety", async () => {
    render(<SystemSafetySettings />);

    const toggle = await screen.findByRole("switch", { name: "システム安全ガードを有効化" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("有効")).toBeTruthy();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/system-safety",
        { systemSafety: false },
        "PATCH",
      );
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("無効")).toBeTruthy();
    expect(screen.getByText(/無効中は OS 変更系コマンド/)).toBeTruthy();
  });

  it("rolls back the switch when saving fails", async () => {
    sendJson.mockRejectedValue(new Error("保存失敗"));
    render(<SystemSafetySettings />);

    const toggle = await screen.findByRole("switch", { name: "システム安全ガードを有効化" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("保存失敗");
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("有効")).toBeTruthy();
  });
});
