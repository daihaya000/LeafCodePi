// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowMdSettings } from "./WorkflowMdSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("WORKFLOW.mdを編集・保存する", async () => {
  getJson.mockResolvedValue({ path: "C:/pi/agent/WORKFLOW.md", exists: false, content: "" });
  sendJson.mockResolvedValue({ ok: true, path: "C:/pi/agent/WORKFLOW.md", exists: true, content: "# 検証手順" });
  render(<WorkflowMdSettings />);
  expect(await screen.findByText("WORKFLOW.md は空です。")).toBeTruthy();
  expect(getJson).toHaveBeenCalledWith("/api/workflow-md");
  fireEvent.click(screen.getByRole("button", { name: "編集" }));
  fireEvent.change(screen.getByRole("textbox", { name: "グローバル WORKFLOW.md" }), { target: { value: "# 検証手順" } });
  fireEvent.click(screen.getByRole("button", { name: "WORKFLOW.md を保存" }));
  await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/workflow-md", { content: "# 検証手順" }, "PATCH"));
  expect(await screen.findByRole("heading", { name: "検証手順" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("保存しました。");
});
