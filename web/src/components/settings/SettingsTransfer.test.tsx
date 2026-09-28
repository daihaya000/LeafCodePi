// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsTransfer } from "./SettingsTransfer";

const { sendJson, refreshServerSettings, prepareServerSettingsImport } = vi.hoisted(() => ({
  sendJson: vi.fn(), refreshServerSettings: vi.fn(), prepareServerSettingsImport: vi.fn(),
}));
vi.mock("@/lib/client", () => ({ sendJson }));
vi.mock("@/lib/setting-sync", () => ({ refreshServerSettings, prepareServerSettingsImport }));

beforeEach(() => {
  sendJson.mockReset();
  refreshServerSettings.mockReset();
  refreshServerSettings.mockResolvedValue(undefined);
  prepareServerSettingsImport.mockReset();
  prepareServerSettingsImport.mockResolvedValue(() => undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SettingsTransfer", () => {
  it("exports the selected scope only after a credentials warning", async () => {
    render(<SettingsTransfer />);
    fireEvent.change(screen.getByLabelText("エクスポート範囲"), { target: { value: "credentials" } });
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "エクスポート" }));
    expect(sendJson).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    sendJson.mockRejectedValue(new Error("認証が必要です"));
    fireEvent.click(screen.getByRole("button", { name: "エクスポート" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "export", scope: "credentials" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "認証が必要です");
  });

  it("imports the scope declared in the archive, not the export selector", async () => {
    render(<SettingsTransfer />);
    const backup = { format: "leafcode-pi-settings", version: 1, scope: "settings", settings: { "auto-optimize": "balanced" } };
    sendJson.mockResolvedValue({ scope: "settings" });
    const file = new File([JSON.stringify(backup)], "backup.json", { type: "application/json" });
    // happy-dom's File may not implement text().
    Object.defineProperty(file, "text", { value: async () => JSON.stringify(backup) });
    fireEvent.change(screen.getByLabelText("バックアップJSONを選択"), { target: { files: [file] } });
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "import", backup }));
    expect(prepareServerSettingsImport).toHaveBeenCalledWith(["auto-optimize"]);
    expect(refreshServerSettings).toHaveBeenCalled();
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});
