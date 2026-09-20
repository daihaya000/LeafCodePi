// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolsMdSettings } from "./ToolsMdSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("ToolsMdSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ path: "C:/pi/agent/TOOLS.md", exists: false, content: "" });
    sendJson.mockResolvedValue({
      ok: true,
      path: "C:/pi/agent/TOOLS.md",
      exists: true,
      content: "# ツール運用",
    });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("TOOLS.md を読み書きする", async () => {
    render(<ToolsMdSettings />);

    await waitFor(() => expect(getJson).toHaveBeenCalledWith("/api/tools-md"));
    expect(await screen.findByText("TOOLS.md は空です。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    const editor = screen.getByRole("textbox", { name: "グローバル TOOLS.md" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# ツール運用" } });
    fireEvent.click(screen.getByRole("button", { name: "TOOLS.md を保存" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith("/api/tools-md", { content: "# ツール運用" }, "PATCH");
    });
  });
});
