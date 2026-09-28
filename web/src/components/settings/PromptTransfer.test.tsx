// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromptTransfer } from "./PromptTransfer";

const { sendJson } = vi.hoisted(() => ({ sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ sendJson }));
const backup = {
  format: "leafcode-pi-prompts", version: 1, exportedAt: "2026-09-28T00:00:00.000Z",
  files: { "USER.md": "old user", "SOUL.md": "old soul", "BOTS.md": "old bots" },
};

beforeEach(() => { sendJson.mockReset(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function chooseBackup(value: unknown = backup) {
  const text = JSON.stringify(value);
  const file = new File([text], "prompts.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => text });
  fireEvent.change(screen.getByLabelText("プロンプトのバックアップJSONを選択"), { target: { files: [file] } });
}

it("shows only files in the archive and imports just the checked names", async () => {
  const onImported = vi.fn();
  sendJson.mockResolvedValue({ imported: ["USER.md", "BOTS.md"], reload: { reloaded: 2, deferred: 1, failed: 0, errors: [] } });
  render(<PromptTransfer onImported={onImported} />);
  chooseBackup();
  await screen.findByLabelText("SOUL.mdをインポート");
  expect(screen.queryByLabelText("DESIGN.mdをインポート")).toBeNull();
  fireEvent.click(screen.getByLabelText("SOUL.mdをインポート"));
  fireEvent.click(screen.getByRole("button", { name: "選択した2件をインポート" }));
  await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/prompts/transfer", {
    action: "import", backup, selected: ["USER.md", "BOTS.md"],
  }));
  expect(onImported).toHaveBeenCalledExactlyOnceWith(["USER.md", "BOTS.md"]);
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "2件のプロンプトをインポートしました。開いているセッションへの反映: 2件成功、1件は処理後に反映、0件失敗。");
});

it("refreshes imported files even if recovery-journal cleanup leaves a warning", async () => {
  const onImported = vi.fn();
  sendJson.mockResolvedValue({
    imported: ["USER.md"], reload: { reloaded: 0, deferred: 0, failed: 0, errors: [] },
    warning: "インポートは完了しましたが、保全ファイルを削除できませんでした。保全ファイル: recovery.json",
  });
  render(<PromptTransfer onImported={onImported} />);
  chooseBackup();
  await screen.findByLabelText("USER.mdをインポート");
  fireEvent.click(screen.getByLabelText("SOUL.mdをインポート"));
  fireEvent.click(screen.getByLabelText("BOTS.mdをインポート"));
  fireEvent.click(screen.getByRole("button", { name: "選択した1件をインポート" }));
  await waitFor(() => expect(onImported).toHaveBeenCalledExactlyOnceWith(["USER.md"]));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("1件のプロンプトをインポートしました"));
  expect(screen.getByRole("alert")).toHaveProperty("textContent", expect.stringContaining("保全ファイルを削除できませんでした"));
});

it("refreshes selected editors when rollback fails and recovery is needed", async () => {
  const onImported = vi.fn();
  sendJson.mockRejectedValueOnce(new Error("設定の自動復旧に失敗しました。保全ファイル: C:/recovery.json"));
  render(<PromptTransfer onImported={onImported} />);
  chooseBackup();
  await screen.findByLabelText("USER.mdをインポート");
  fireEvent.click(screen.getByLabelText("SOUL.mdをインポート"));
  fireEvent.click(screen.getByLabelText("BOTS.mdをインポート"));
  fireEvent.click(screen.getByRole("button", { name: "選択した1件をインポート" }));
  await waitFor(() => expect(onImported).toHaveBeenCalledExactlyOnceWith(["USER.md"]));
  expect(screen.getByRole("alert")).toHaveProperty("textContent", expect.stringContaining("保全ファイル:"));
  expect(screen.queryByLabelText("USER.mdをインポート")).toBeNull();
});

it("asks before exporting potentially sensitive prompts", async () => {
  render(<PromptTransfer onImported={vi.fn()} />);
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "エクスポート" }));
  expect(sendJson).not.toHaveBeenCalled();
  sendJson.mockRejectedValueOnce(new Error("認証が必要です"));
  fireEvent.click(screen.getByRole("button", { name: "エクスポート" }));
  await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/prompts/transfer", { action: "export" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "認証が必要です");
});

it("blocks zero selected files and refuses invalid archive names", async () => {
  render(<PromptTransfer onImported={vi.fn()} />);
  chooseBackup();
  await screen.findByLabelText("USER.mdをインポート");
  for (const name of ["USER.md", "SOUL.md", "BOTS.md"]) fireEvent.click(screen.getByLabelText(`${name}をインポート`));
  expect(screen.getByRole("button", { name: "選択した0件をインポート" }).hasAttribute("disabled")).toBe(true);
  chooseBackup({ ...backup, files: { "../auth.json": "secret" } });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "バックアップに有効なプロンプトファイルがありません");
  expect(sendJson).not.toHaveBeenCalled();
});
