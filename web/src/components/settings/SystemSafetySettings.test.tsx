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
    getJson.mockResolvedValue({ level: "strict", systemSafety: true });
    sendJson.mockResolvedValue({ level: "low", systemSafety: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the current level and can change intensity", async () => {
    render(<SystemSafetySettings />);

    const select = await screen.findByRole("combobox", { name: "システム安全ガードの度合い" });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("strict"));
    expect(screen.getByText(/調査・影響\/復旧計画・明示承認/)).toBeTruthy();

    fireEvent.change(select, { target: { value: "low" } });

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/system-safety",
        { level: "low" },
        "PATCH",
      );
    });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("low"));
    expect(screen.getByText(/確認ダイアログ1回/)).toBeTruthy();
  });

  it("rolls back the select when saving fails", async () => {
    sendJson.mockRejectedValue(new Error("保存失敗"));
    render(<SystemSafetySettings />);

    const select = await screen.findByRole("combobox", { name: "システム安全ガードの度合い" });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("strict"));
    fireEvent.change(select, { target: { value: "off" } });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("保存失敗");
    });
    expect((select as HTMLSelectElement).value).toBe("strict");
  });
});
