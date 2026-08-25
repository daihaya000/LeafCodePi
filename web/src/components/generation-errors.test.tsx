// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextTaskSuggest } from "@/components/home/NextTaskSuggest";
import { DiffPane } from "@/components/task/DiffPane";
import { NextAction } from "@/components/task/NextAction";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({
  getJson: mocks.getJson,
  sendJson: mocks.sendJson,
}));

const providerError = "429: stealth/ox-alpha is temporarily rate-limited upstream";

describe("generation error details", () => {
  beforeEach(() => {
    mocks.getJson.mockReset();
    mocks.sendJson.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the NextAction API error", async () => {
    mocks.sendJson.mockRejectedValue(new Error(providerError));
    render(
      <NextAction
        taskId="task-1"
        sessionId="session-1"
        onApply={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "次の指示を提案" }));

    expect((await screen.findByRole("alert")).textContent).toContain(providerError);
  });

  it("shows the NextTask API error", async () => {
    mocks.sendJson.mockRejectedValue(new Error(providerError));
    render(
      <NextTaskSuggest
        projectId="project-1"
        onApply={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "次のタスクを提案" }));

    expect((await screen.findByRole("alert")).textContent).toContain(providerError);
  });

  it("shows the model used for small suggestions", async () => {
    mocks.sendJson.mockResolvedValue({
      suggestion: "テストを追加する",
      suggestions: ["テストを追加する"],
      model: { providerID: "opencode-go", modelID: "mimo-v2.5" },
    });
    render(
      <NextAction
        taskId="task-1"
        sessionId="session-1"
        onApply={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "次の指示を提案" }));

    expect(await screen.findByText("mimo-v2.5")).toBeTruthy();
    expect(screen.getByText("生成モデル:")).toBeTruthy();
  });

  it("shows the model used for the next-task suggestion", async () => {
    mocks.sendJson.mockResolvedValue({
      suggestion: "テストを追加する",
      suggestions: ["テストを追加する"],
      model: { providerID: "opencode-go", modelID: "mimo-v2.5" },
    });
    render(
      <NextTaskSuggest
        projectId="project-1"
        onApply={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "次のタスクを提案" }));

    expect(await screen.findByText("mimo-v2.5")).toBeTruthy();
  });

  it("shows when commit-message generation used its deterministic fallback", async () => {
    mocks.getJson.mockImplementation((path: string) => {
      if (path === "/api/diff/files") {
        return Promise.resolve({
          git: true,
          branch: "master",
          files: [{
            path: "src/app.ts",
            additions: 1,
            deletions: 0,
            binary: false,
            untracked: false,
            hunks: [],
          }],
          additions: 1,
          deletions: 0,
        });
      }
      if (path === "/api/git/branches") {
        return Promise.resolve({
          current: "master",
          branches: ["master"],
          defaultTarget: null,
          hasRemote: false,
        });
      }
      if (path === "/api/git/pr") return Promise.resolve({ available: false });
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    const warning = `AI生成に失敗したため、ファイル情報から生成しました: ${providerError}`;
    mocks.sendJson.mockResolvedValue({ message: "更新 app.ts", warning });
    render(<DiffPane directory="C:\\repo" />);

    await screen.findByText("app.ts");
    fireEvent.click(screen.getByRole("button", { name: "Commit パネル" }));
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "コミットメッセージ" }) as HTMLInputElement).value).toBe("更新 app.ts");
      expect(screen.getByRole("alert").textContent).toContain(warning);
    });
  });
});
