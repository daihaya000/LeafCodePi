// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitGuardSettings } from "./CommitGuardSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("CommitGuardSettings", () => {
  beforeEach(() => {
    getJson.mockReset();
    sendJson.mockReset();
    getJson.mockResolvedValue({
      extensions: [{ id: "leafcode-commit-guard", name: "leafcode-commit-guard", enabled: true }],
    });
    sendJson.mockResolvedValue({
      extensions: [{ id: "leafcode-commit-guard", name: "leafcode-commit-guard", enabled: false }],
      enabled: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the current state and can disable the commit guard", async () => {
    render(<CommitGuardSettings />);

    const toggle = await screen.findByRole("switch", { name: "コミットガードを有効にする" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("有効")).toBeTruthy();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/extensions/leafcode-commit-guard",
        { enabled: false },
        "PATCH",
      );
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("無効")).toBeTruthy();
  });

  it("rolls back when saving fails", async () => {
    sendJson.mockRejectedValue(new Error("保存失敗"));
    render(<CommitGuardSettings />);

    const toggle = await screen.findByRole("switch", { name: "コミットガードを有効にする" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("保存失敗");
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
