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
    getJson.mockImplementation(async (path: string) => {
      if (path.includes("title-auto-update-enabled")) return { value: null };
      return { value: null };
    });
    sendJson.mockResolvedValue({ value: "5" });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("既定値を表示し、サーバー保存値を新しいブラウザへ反映する", async () => {
    getJson.mockImplementation(async (path: string) => {
      if (path.includes("title-auto-update-enabled")) return { value: "1" };
      return { value: "10" };
    });
    render(<TitleAutoUpdateSettings />);

    const input = screen.getByLabelText("タイトル自動更新の頻度") as HTMLInputElement;
    const toggle = screen.getByRole("switch", { name: "タイトル自動更新の既定" });
    expect(input.value).toBe("5");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(input.value).toBe("10"));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(localStorage.getItem("webui:title-auto-update-frequency")).toBe("10");
    expect(localStorage.getItem("webui:title-auto-update-enabled")).toBe("1");
  });

  it("変更をlocalStorageへ即時反映し、サーバーへ同期する", async () => {
    render(<TitleAutoUpdateSettings />);
    const input = screen.getByLabelText("タイトル自動更新の頻度") as HTMLInputElement;
    const toggle = screen.getByRole("switch", { name: "タイトル自動更新の既定" });

    fireEvent.click(toggle);
    expect(localStorage.getItem("webui:title-auto-update-enabled")).toBe("1");
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/title-auto-update-enabled",
      { value: "1" },
      "PUT",
    ));

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
