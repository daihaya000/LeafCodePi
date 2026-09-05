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
    getJson.mockResolvedValue({ enabled: true });
    sendJson.mockResolvedValue({ enabled: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the feature flag and toggles it without touching extensions", async () => {
    render(<CommitGuardSettings />);

    const toggle = await screen.findByRole("switch", { name: "コミットガードを有効にする" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("有効")).toBeTruthy();
    expect(getJson).toHaveBeenCalledWith("/api/settings/commit-guard");

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/commit-guard",
        { enabled: false },
        "PATCH",
      );
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("無効")).toBeTruthy();
  });

  it("keeps the switch disabled and shows unknown when the initial fetch fails", async () => {
    getJson.mockRejectedValue(new Error("取得失敗"));
    render(<CommitGuardSettings />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("取得失敗");
    });
    const toggle = screen.getByRole("switch", { name: "コミットガードを有効にする" });
    expect(toggle).toHaveProperty("disabled", true);
    expect(screen.getByText("不明")).toBeTruthy();
    expect(sendJson).not.toHaveBeenCalled();
  });
});
