// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTaskSessionCache } from "@/lib/task-session-cache";
import type { TaskSummary } from "@/lib/types";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => mocks);
vi.mock("@/components/shell/MobileMenuHeader", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/task/PartView", () => ({ PartView: () => null, WorkingRow: () => null }));

import { TaskView } from "./TaskView";

const task: TaskSummary = {
  id: "draft-task", projectId: null, projectName: "test", title: "draft test", directory: "",
  isolation: "current_folder", status: "idle", sessionId: null, sessionFile: null,
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("EventSource", class extends EventTarget { close() {} });
  mocks.getJson.mockResolvedValue({ models: [], agents: [], skills: [], accounts: [] });
  saveTaskSessionCache({ task, messages: [], isStreaming: false, isCompacting: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("TaskView draft submission", () => {
  it("preserves a new draft while starting a goal loop", async () => {
    let resolve!: (value: unknown) => void;
    mocks.sendJson.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<TaskView taskId={task.id} mdUp />);
    fireEvent.click(screen.getByRole("button", { name: "ループで継続実行" }));
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "goal" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "next draft" } });
    await act(async () => { resolve({ loop: null }); });
    expect(input.value).toBe("next draft");
  });

  it.each([false, true])("restores an untouched draft after failure (goal loop: %s)", async (goalLoop) => {
    mocks.sendJson.mockRejectedValue(new Error("request failed"));
    render(<TaskView taskId={task.id} mdUp />);
    if (goalLoop) fireEvent.click(screen.getByRole("button", { name: "ループで継続実行" }));
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "retry this" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await screen.findByText("request failed");
    expect(input.value).toBe("retry this");
  });

  it.each(["success", "failure"])("preserves text and attachments entered during a pending %s", async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    mocks.sendJson.mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no; }));
    const { container } = render(<TaskView taskId={task.id} mdUp />);
    const input = screen.getByRole("textbox", { name: "フォローアップ" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "first prompt" } });
    fireEvent.submit(screen.getByRole("form", { name: "フォローアップ" }));
    await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
      `/api/tasks/${task.id}/prompt`, expect.objectContaining({ prompt: "first prompt" }),
    ));
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "next draft" } });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["image"], "next.png", { type: "image/png" })] },
    });
    await screen.findByRole("img", { name: "next.png" });
    await act(async () => {
      if (outcome === "success") resolve({ task });
      else reject(new Error("request failed"));
    });
    expect(input.value).toBe("next draft");
    expect(screen.getByRole("img", { name: "next.png" })).toBeTruthy();
  });
});
