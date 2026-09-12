// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserMdSettings } from "./UserMdSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("UserMdSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ path: "C:/pi/agent/USER.md", exists: false, content: "" });
    sendJson.mockResolvedValue({
      ok: true,
      path: "C:/pi/agent/USER.md",
      exists: true,
      content: "# プロフィール",
      reload: { reloaded: 1, failed: 0, errors: [] },
    });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("USER.md を /api/user-md から読み書きする", async () => {
    render(<UserMdSettings />);

    await waitFor(() => expect(getJson).toHaveBeenCalledWith("/api/user-md"));
    expect(await screen.findByText("USER.md は空です。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    const editor = screen.getByRole("textbox", { name: "グローバル USER.md" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# プロフィール" } });
    fireEvent.click(screen.getByRole("button", { name: "USER.md を保存" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith("/api/user-md", { content: "# プロフィール" }, "PATCH");
    });
  });
});
