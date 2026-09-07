// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsMdSettings } from "./BotsMdSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("BotsMdSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ path: "C:/pi/agent/BOTS.md", exists: false, content: "" });
    sendJson.mockResolvedValue({
      ok: true,
      path: "C:/pi/agent/BOTS.md",
      exists: true,
      content: "# ボット共通",
      reload: { reloaded: 2, failed: 0, errors: [] },
    });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("BOTS.md を /api/bots-md から読み書きする", async () => {
    render(<BotsMdSettings />);

    await waitFor(() => expect(getJson).toHaveBeenCalledWith("/api/bots-md"));
    expect(await screen.findByText("BOTS.md は空です。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    const editor = screen.getByRole("textbox", { name: "グローバル BOTS.md" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# ボット共通" } });
    fireEvent.click(screen.getByRole("button", { name: "BOTS.md を保存" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith("/api/bots-md", { content: "# ボット共通" }, "PATCH");
    });
    expect(screen.getByRole("status").textContent).toContain("2 件のセッション");
  });
});
