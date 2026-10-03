// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const recoveryId = "12345678-1234-1234-1234-123456789abc";

function backupFile(backup: unknown): File {
  const file = new File([JSON.stringify(backup)], "backup.json", { type: "application/json" });
  // happy-dom's File may not implement text().
  Object.defineProperty(file, "text", { value: async () => JSON.stringify(backup) });
  return file;
}

function openRecoveryDisclosure(): HTMLElement {
  const summary = screen.getByText("保全ファイル", { selector: "summary" });
  const disclosure = summary.closest("details");
  if (!disclosure) throw new Error("保全ファイルの折り畳みがありません");
  fireEvent.click(summary);
  return disclosure;
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
    sendJson.mockRejectedValueOnce(new Error(`設定の自動復旧に失敗しました。保全ファイル: C:\\data\\settings-transfer-recovery\\${recoveryId}.json`));
    sendJson.mockResolvedValueOnce({ recovered: true });
    fireEvent.change(screen.getByLabelText("認証JSONを選択"), { target: { files: [backupFile(credentialsBackup)] } });
    fireEvent.click(await screen.findByRole("button", { name: "保全ファイルから復旧" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "recover", recoveryId }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "保全ファイルから復旧しました。LeafCodePiを再起動してください。");
  });

  it("does not suggest rollback when the import succeeded but journal cleanup failed", async () => {
    render(<SettingsTransfer />);
    sendJson.mockRejectedValueOnce(new Error(`インポートは完了しましたが、保全ファイルを削除できませんでした。保全ファイル: C:\\data\\settings-transfer-recovery\\${recoveryId}.json`));
    fireEvent.change(screen.getByLabelText("認証JSONを選択"), { target: { files: [backupFile(credentialsBackup)] } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保全ファイルから復旧" })).toBeNull();
  });

  it("keeps journal maintenance collapsed and discards a journal left after a server restart", async () => {
    getJson.mockResolvedValue({ recoveries: [recoveryId] });
    sendJson.mockResolvedValue({ discarded: true });
    render(<SettingsTransfer />);
    expect(screen.getByText("保全ファイル", { selector: "summary" }).closest("details")?.hasAttribute("open")).toBe(false);
    const disclosure = openRecoveryDisclosure();
    fireEvent.click(within(disclosure).getByRole("button", { name: "異常終了後の保全ファイルを確認" }));
    await within(disclosure).findByText(recoveryId);
    fireEvent.click(within(disclosure).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "discard-recovery", recoveryId }));
    expect(screen.queryByText(recoveryId)).toBeNull();
    expect(screen.getByRole("status")).toHaveProperty("textContent", "保全ファイルを削除しました");
  });

  it("restores a listed journal and reports when none remain", async () => {
    getJson.mockResolvedValueOnce({ recoveries: [recoveryId] }).mockResolvedValueOnce({ recoveries: [] });
    sendJson.mockResolvedValue({ recovered: true });
    render(<SettingsTransfer />);
    const disclosure = openRecoveryDisclosure();
    fireEvent.click(within(disclosure).getByRole("button", { name: "異常終了後の保全ファイルを確認" }));
    fireEvent.click(await within(disclosure).findByRole("button", { name: "復旧" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "recover", recoveryId }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "保全ファイルから復旧しました。LeafCodePiを再起動してください。");
    expect(screen.queryByText(recoveryId)).toBeNull();
    fireEvent.click(within(disclosure).getByRole("button", { name: "異常終了後の保全ファイルを確認" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("保全ファイルはありません"));
  });

  it("resets stored provider credentials after confirmation and reports the backup", async () => {
    sendJson.mockResolvedValue({ backupPath: "C:\\data\\credential-backups\\leafcode-pi-credentials-x.json", accountCount: 2 });
    render(<SettingsTransfer />);
    const disclosure = screen.getByText("認証の初期化", { selector: "summary" }).closest("details");
    expect(disclosure?.hasAttribute("open")).toBe(false);
    fireEvent.click(within(disclosure!).getByRole("button", { name: "初期化" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", undefined, "DELETE"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("プロバイダー認証を初期化します"));
    expect((await screen.findByRole("status")).textContent).toContain("leafcode-pi-credentials-x.json");
    expect((await screen.findByRole("status")).textContent).toContain("初期化しました");
  });

  it("does not reset credentials when the confirmation is declined", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<SettingsTransfer />);
    const disclosure = screen.getByText("認証の初期化", { selector: "summary" }).closest("details");
    fireEvent.click(within(disclosure!).getByRole("button", { name: "初期化" }));
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("keeps the reset report and warns when the journal cannot be removed afterwards", async () => {
    sendJson.mockResolvedValue({
      backupPath: "C:\\data\\credential-backups\\leafcode-pi-credentials-x.json", accountCount: 1,
      warning: "初期化は完了しましたが、保全ファイルを削除できませんでした。保全ファイル: C:\\data\\settings-transfer-recovery\\x.json",
    });
    render(<SettingsTransfer />);
    fireEvent.click(within(screen.getByText("認証の初期化", { selector: "summary" }).closest("details")!).getByRole("button", { name: "初期化" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("初期化は完了しましたが"));
    expect(screen.getByRole("status").textContent).toContain("初期化しました");
  });

  it("offers recovery when a credential reset rolls back and cannot restore", async () => {
    render(<SettingsTransfer />);
    sendJson.mockRejectedValueOnce(new Error(`設定の自動復旧に失敗しました。保全ファイル: C:\\data\\settings-transfer-recovery\\${recoveryId}.json`));
    sendJson.mockResolvedValueOnce({ recovered: true });
    fireEvent.click(within(screen.getByText("認証の初期化", { selector: "summary" }).closest("details")!).getByRole("button", { name: "初期化" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("設定の自動復旧に失敗しました"));
    fireEvent.click(await screen.findByRole("button", { name: "保全ファイルから復旧" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/settings/transfer", { action: "recover", recoveryId }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "保全ファイルから復旧しました。LeafCodePiを再起動してください。");
  });
});
