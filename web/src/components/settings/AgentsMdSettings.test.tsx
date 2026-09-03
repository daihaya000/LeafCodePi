// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsMdSettings } from "./AgentsMdSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("AgentsMdSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({
      path: "C:/pi/agent/AGENTS.md",
      exists: true,
      content: "# 既定の指示\n\n- 簡潔に答える",
    });
    sendJson.mockResolvedValue({
      ok: true,
      path: "C:/pi/agent/AGENTS.md",
      exists: true,
      content: "# 更新した指示",
    });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("Markdownを既定表示し、編集ボタンから編集して保存する", async () => {
    render(<AgentsMdSettings />);

    const heading = await screen.findByRole("heading", { name: "既定の指示" });
    expect(heading.closest(".md")?.className).toContain("border-border");
    expect(screen.queryByRole("textbox", { name: "グローバル AGENTS.md" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    const editor = screen.getByRole("textbox", { name: "グローバル AGENTS.md" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("# 既定の指示\n\n- 簡潔に答える");

    fireEvent.change(editor, { target: { value: "# 更新した指示" } });
    fireEvent.click(screen.getByRole("button", { name: "AGENTS.md を保存" }));

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith("/api/agents-md", { content: "# 更新した指示" }, "PATCH");
      expect(screen.queryByRole("textbox", { name: "グローバル AGENTS.md" })).toBeNull();
    });
    expect(screen.getByRole("heading", { name: "更新した指示" })).toBeTruthy();
  });
});
