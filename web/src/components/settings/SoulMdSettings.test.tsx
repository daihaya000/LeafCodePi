// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoulMdSettings } from "./SoulMdSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("SoulMdSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ path: "C:/pi/agent/SOUL.md", exists: false, content: "" });
    sendJson.mockResolvedValue({
      ok: true,
      path: "C:/pi/agent/SOUL.md",
      exists: true,
      content: "# 性格",
      reload: { reloaded: 1, failed: 0, errors: [] },
    });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("SOUL.md を /api/soul-md から読み書きする", async () => {
    render(<SoulMdSettings />);

    await waitFor(() => expect(getJson).toHaveBeenCalledWith("/api/soul-md"));
    expect(await screen.findByText("SOUL.md は空です。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    const editor = screen.getByRole("textbox", { name: "グローバル SOUL.md" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# 性格" } });
    fireEvent.click(screen.getByRole("button", { name: "SOUL.md を保存" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith("/api/soul-md", { content: "# 性格" }, "PATCH");
    });
  });
});
