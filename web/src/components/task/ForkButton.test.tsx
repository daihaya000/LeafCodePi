// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn(), push: vi.fn(), notify: vi.fn() }));
vi.mock("@/spa/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/client", () => ({ sendJson: mocks.send }));
vi.mock("@/lib/events", () => ({ notifyTasksChanged: mocks.notify }));
import { ForkButton } from "./ForkButton";
import { takeForkDraft } from "@/lib/task-fork";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });

describe("ForkButton", () => {
  it("confirms workspace sharing and cancels without a request", () => {
    render(<ForkButton taskId="source" entryId="input" />);
    fireEvent.click(screen.getByRole("button", { name: "ここから分岐" }));
    expect(screen.getByRole("dialog", { name: "ここから分岐" })).toBeTruthy();
    expect(screen.getByText(/作業ファイルは共有/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("creates one fork and opens it with original input and attachments as an unsent draft", async () => {
    const draft = { text: "別案に変更する", images: [{ uri: "data:image/png;base64,YQ==", mime: "image/png" }], files: [] };
    let finish!: (value: unknown) => void;
    mocks.send.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<ForkButton taskId="source" entryId="input" />);
    fireEvent.click(screen.getByRole("button", { name: "ここから分岐" }));
    const confirm = screen.getByRole("button", { name: "分岐して編集" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith("/api/tasks/source/fork", { entryId: "input" });
    finish({ task: { id: "forked-ui" }, ...draft });
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/task/forked-ui"));
    expect(takeForkDraft("forked-ui")).toEqual(draft);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("shows errors and allows a retry without leaving the original session", async () => {
    mocks.send.mockRejectedValueOnce(new Error("処理中は分岐できません"));
    render(<ForkButton taskId="source" entryId="input" />);
    fireEvent.click(screen.getByRole("button", { name: "ここから分岐" }));
    fireEvent.click(screen.getByRole("button", { name: "分岐して編集" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("処理中は分岐できません"));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "分岐して編集" }).disabled).toBe(false);
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
