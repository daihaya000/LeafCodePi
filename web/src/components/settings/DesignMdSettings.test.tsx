// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignMdSettings } from "./DesignMdSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("DesignMdSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ path: "C:/pi/agent/DESIGN.md", exists: false, content: "" });
    sendJson.mockResolvedValue({
      ok: true,
      path: "C:/pi/agent/DESIGN.md",
      exists: true,
      content: "# UIデザイン",
    });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("DESIGN.md を読み書きする", async () => {
    render(<DesignMdSettings />);

    await waitFor(() => expect(getJson).toHaveBeenCalledWith("/api/design-md"));
    expect(await screen.findByText("DESIGN.md は空です。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    const editor = screen.getByRole("textbox", { name: "グローバル DESIGN.md" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# UIデザイン" } });
    fireEvent.click(screen.getByRole("button", { name: "DESIGN.md を保存" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith("/api/design-md", { content: "# UIデザイン" }, "PATCH");
    });
  });
});
