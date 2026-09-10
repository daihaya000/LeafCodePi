// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleAutoUpdateSettings } from "./TitleAutoUpdateSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("TitleAutoUpdateSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    getJson.mockResolvedValue({ value: null });
    sendJson.mockResolvedValue({ value: "5" });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("既定値を表示し、サーバー保存値を新しいブラウザへ反映する", async () => {
    getJson.mockResolvedValue({ value: "10" });
    render(<TitleAutoUpdateSettings />);

    const input = screen.getByLabelText("タイトル自動更新の頻度") as HTMLInputElement;
    expect(input.value).toBe("5");
    await waitFor(() => expect(input.value).toBe("10"));
    expect(localStorage.getItem("webui:title-auto-update-frequency")).toBe("10");
  });

  it("変更をlocalStorageへ即時反映し、サーバーへ同期する", async () => {
    render(<TitleAutoUpdateSettings />);
    const input = screen.getByLabelText("タイトル自動更新の頻度") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);

    expect(localStorage.getItem("webui:title-auto-update-frequency")).toBe("10");
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/title-auto-update-frequency",
      { value: "10" },
      "PUT",
    ));
  });
});
