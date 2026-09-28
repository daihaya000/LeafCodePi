// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileSettings } from "./ProfileSettings";

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    if (String(input) === "/api/profile?backups=1") return jsonResponse({ backups: [] });
    throw new Error(`unexpected fetch: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ProfileSettings", () => {
  it("uses the shared export/import row and keeps reset collapsed", async () => {
    render(<ProfileSettings />);
    expect(screen.getByRole("heading", { name: "設定エクスポート" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "エクスポート" })).toBeTruthy();
    const input = screen.getByLabelText("設定ファイルを選択") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".lcp.gz,application/gzip");
    const reset = screen.getByText("設定の初期化", { selector: "summary" }).closest("details");
    expect(reset?.hasAttribute("open")).toBe(false);
    expect(within(reset!).getByRole("button", { name: "初期化" })).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/profile?backups=1", { cache: "no-store" }));
  });

  it("imports the chosen file and offers the automatic backup for restore", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/profile?backups=1") return jsonResponse({ backups: [] });
      if (String(input) === "/api/profile" && init?.method === "POST") {
        return jsonResponse({ ok: true, fileCount: 3, backupPath: "C:\\data\\profile-backups\\leafcode-pi-profile-x.bak.lcp.gz" });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    render(<ProfileSettings />);
    const file = new File(["archive"], "settings.lcp.gz", { type: "application/gzip" });
    fireEvent.change(screen.getByLabelText("設定ファイルを選択"), { target: { files: [file] } });
    expect((await screen.findByRole("status")).textContent).toContain("3件を復元しました");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect((post?.[1]?.body as FormData | undefined)?.get("profile")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "復元するバックアップ" })).toBeTruthy();
  });

  it("uses settings wording in the export confirmation and fallback error", async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/profile?backups=1") return jsonResponse({ backups: [] });
      return jsonResponse({}, 500);
    });
    render(<ProfileSettings />);
    fireEvent.click(screen.getByRole("button", { name: "エクスポート" }));
    expect(window.confirm).toHaveBeenCalledWith("認証情報とWebUIパスワードを含む設定一式をエクスポートします。安全な場所に保管してください。");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "設定の処理に失敗しました");
  });
});
