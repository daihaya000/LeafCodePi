// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsTransfer } from "./SettingsTransfer";

const { getJson, sendJson, refreshServerSettings, prepareServerSettingsImport } = vi.hoisted(() => ({
  getJson: vi.fn(), sendJson: vi.fn(), refreshServerSettings: vi.fn(), prepareServerSettingsImport: vi.fn(),
}));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));
vi.mock("@/lib/setting-sync", () => ({ refreshServerSettings, prepareServerSettingsImport }));

beforeEach(() => {
  getJson.mockReset();
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

  it("offers recovery after the server reports a preserved snapshot", async () => {
    render(<SettingsTransfer />);
    const backup = { format: "leafcode-pi-settings", version: 1, scope: "settings", settings: {} };
    const file = new File([JSON.stringify(backup)], "backup.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => JSON.stringify(backup) });
    const recoveryId = "12345678-1234-1234-1234-123456789abc";
    sendJson.mockRejectedValueOnce(new Error(`設定の自動復旧に失敗しました。保全ファイル: C:\\data\\settings-transfer-recovery\\${recoveryId}.json`));
    sendJson.mockResolvedValueOnce({ recovered: true });
    fireEvent.change(screen.getByLabelText("バックアップJSONを選択"), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "保全ファイルから復旧" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "recover", recoveryId }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "保全ファイルから復旧しました。LeafCodePiを再起動してください。");
  });

  it("does not suggest rollback when the import succeeded but journal cleanup failed", async () => {
    render(<SettingsTransfer />);
    const backup = { format: "leafcode-pi-settings", version: 1, scope: "settings", settings: {} };
    const file = new File([JSON.stringify(backup)], "backup.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => JSON.stringify(backup) });
    sendJson.mockRejectedValueOnce(new Error("インポートは完了しましたが、保全ファイルを削除できませんでした。保全ファイル: C:\\data\\settings-transfer-recovery\\12345678-1234-1234-1234-123456789abc.json"));
    fireEvent.change(screen.getByLabelText("バックアップJSONを選択"), { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保全ファイルから復旧" })).toBeNull();
  });

  it("discovers and discards a journal left after a server restart", async () => {
    const recoveryId = "12345678-1234-1234-1234-123456789abc";
    getJson.mockResolvedValue({ recoveries: [recoveryId] });
    sendJson.mockResolvedValue({ discarded: true });
    render(<SettingsTransfer />);
    fireEvent.click(screen.getByRole("button", { name: "異常終了後の保全ファイルを確認" }));
    await screen.findByText(recoveryId);
    fireEvent.click(screen.getByRole("button", { name: "保全ファイルを削除" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "discard-recovery", recoveryId }));
    expect(screen.queryByText(recoveryId)).toBeNull();
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
