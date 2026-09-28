// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsTransfer } from "./SettingsTransfer";

const { getJson, sendJson, refreshServerSettings, prepareServerSettingsImport } = vi.hoisted(() => ({
  getJson: vi.fn(), sendJson: vi.fn(), refreshServerSettings: vi.fn(), prepareServerSettingsImport: vi.fn(),
}));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));
vi.mock("@/lib/setting-sync", () => ({ refreshServerSettings, prepareServerSettingsImport }));

const credentialsBackup = {
  format: "leafcode-pi-settings", version: 1, scope: "credentials",
  credentials: { defaultAuth: {}, accounts: [], sharedCookies: {} },
};

function backupFile(backup: unknown): File {
  const file = new File([JSON.stringify(backup)], "backup.json", { type: "application/json" });
  // happy-dom's File may not implement text().
  Object.defineProperty(file, "text", { value: async () => JSON.stringify(backup) });
  return file;
}

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
  it("exports provider credentials only after a plaintext warning", async () => {
    render(<SettingsTransfer />);
    expect(screen.getByRole("heading", { name: "認証エクスポート" })).toBeTruthy();
    expect(screen.queryByLabelText("エクスポート範囲")).toBeNull();
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "エクスポート" }));
    expect(sendJson).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    sendJson.mockRejectedValue(new Error("認証が必要です"));
    fireEvent.click(screen.getByRole("button", { name: "エクスポート" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "export", scope: "credentials" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "認証が必要です");
  });

  it("downloads the credentials backup as JSON", async () => {
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = vi.fn(() => "blob:credentials");
    URL.revokeObjectURL = vi.fn();
    try {
      sendJson.mockResolvedValue({ backup: credentialsBackup });
      render(<SettingsTransfer />);
      fireEvent.click(screen.getByRole("button", { name: "エクスポート" }));
      expect(await screen.findByRole("status")).toHaveProperty("textContent", "プロバイダー認証をエクスポートしました");
      expect(downloads).toHaveLength(1);
      expect(downloads[0]).toMatch(/^leafcode-pi-credentials-\d{4}-\d{2}-\d{2}\.json$/);
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  it("imports a credentials backup after confirming its scope", async () => {
    sendJson.mockResolvedValue({ scope: "credentials" });
    render(<SettingsTransfer />);
    fireEvent.change(screen.getByLabelText("認証JSONを選択"), { target: { files: [backupFile(credentialsBackup)] } });
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "import", backup: credentialsBackup }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("プロバイダー認証を取り込みます"));
    expect(prepareServerSettingsImport).toHaveBeenCalledWith([]);
    expect((await screen.findByRole("status")).textContent).toContain("プロバイダー認証をインポートしました");
  });

  it("still imports legacy backups that contain WebUI settings", async () => {
    const backup = { format: "leafcode-pi-settings", version: 1, scope: "settings", settings: { "auto-optimize": "balanced" } };
    sendJson.mockResolvedValue({ scope: "settings" });
    render(<SettingsTransfer />);
    fireEvent.change(screen.getByLabelText("認証JSONを選択"), { target: { files: [backupFile(backup)] } });
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "import", backup }));
    expect(prepareServerSettingsImport).toHaveBeenCalledWith(["auto-optimize"]);
    expect(refreshServerSettings).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toContain("WebUI動作設定をインポートしました");
  });

  it("offers recovery after the server reports a preserved snapshot", async () => {
    render(<SettingsTransfer />);
    const recoveryId = "12345678-1234-1234-1234-123456789abc";
    sendJson.mockRejectedValueOnce(new Error(`設定の自動復旧に失敗しました。保全ファイル: C:\\data\\settings-transfer-recovery\\${recoveryId}.json`));
    sendJson.mockResolvedValueOnce({ recovered: true });
    fireEvent.change(screen.getByLabelText("認証JSONを選択"), { target: { files: [backupFile(credentialsBackup)] } });
    fireEvent.click(await screen.findByRole("button", { name: "保全ファイルから復旧" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "recover", recoveryId }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "保全ファイルから復旧しました。LeafCodePiを再起動してください。");
  });

  it("does not suggest rollback when the import succeeded but journal cleanup failed", async () => {
    render(<SettingsTransfer />);
    sendJson.mockRejectedValueOnce(new Error("インポートは完了しましたが、保全ファイルを削除できませんでした。保全ファイル: C:\\data\\settings-transfer-recovery\\12345678-1234-1234-1234-123456789abc.json"));
    fireEvent.change(screen.getByLabelText("認証JSONを選択"), { target: { files: [backupFile(credentialsBackup)] } });
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
});
