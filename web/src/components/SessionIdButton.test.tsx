// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionIdButton } from "./SessionIdButton";

const sessionId = "01a0efee-1234-5678-9012-123456789abc";
const writeText = vi.fn();
const execCommand = vi.fn();
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  execCommand.mockReset().mockReturnValue(true);
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
});

it("shows a discreet ID label and opens the full, selectable Pi ID", () => {
  render(<SessionIdButton sessionId={sessionId} />);
  const trigger = screen.getByRole("button", { name: "セッションIDを確認" });
  expect(trigger.textContent).toBe("ID");
  expect(trigger.title).toContain(sessionId);
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "セッションID" });
  const input = screen.getByRole("textbox", { name: "完全なセッションID" }) as HTMLInputElement;
  expect(input.value).toBe(sessionId);
  fireEvent.focus(input);
  expect(input.selectionEnd).toBe(sessionId.length);
  fireEvent.click(screen.getByRole("button", { name: "セッションIDを閉じる" }));
  expect((dialog as HTMLDialogElement).open).toBe(false);
});

it("copies the full ID rather than its prefix", async () => {
  render(<SessionIdButton sessionId={sessionId} />);
  fireEvent.click(screen.getByRole("button", { name: "セッションIDを確認" }));
  fireEvent.click(screen.getByRole("button", { name: "IDをコピー" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("コピーした"));
  expect(writeText).toHaveBeenCalledWith(sessionId);
  expect(execCommand).not.toHaveBeenCalled();
});

it.each(["rejected", "unavailable"])("copies through the modal input when Clipboard API is %s", async (mode) => {
  if (mode === "unavailable") vi.stubGlobal("navigator", {});
  else writeText.mockRejectedValue(new Error("denied"));
  execCommand.mockImplementation(() => {
    const input = screen.getByRole("textbox", { name: "完全なセッションID" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.closest("dialog")?.open).toBe(true);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(sessionId.length);
    expect(input.value).toBe(sessionId);
    return true;
  });
  render(<SessionIdButton sessionId={sessionId} />);
  fireEvent.click(screen.getByRole("button", { name: "セッションIDを確認" }));
  const copyButton = screen.getByRole("button", { name: "IDをコピー" });
  copyButton.focus();
  fireEvent.click(copyButton);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("コピーした"));
  expect(execCommand).toHaveBeenCalledWith("copy");
  expect(document.activeElement).toBe(copyButton);
});

it.each(["false", "throw"])("offers manual copying when both copy paths fail (%s)", async (mode) => {
  vi.stubGlobal("navigator", {});
  if (mode === "throw") execCommand.mockImplementation(() => { throw new Error("blocked"); });
  else execCommand.mockReturnValue(false);
  render(<SessionIdButton sessionId={sessionId} />);
  fireEvent.click(screen.getByRole("button", { name: "セッションIDを確認" }));
  fireEvent.click(screen.getByRole("button", { name: "IDをコピー" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("手動でコピー"));
});

it("does not substitute the task ID when no session exists", () => {
  render(<SessionIdButton sessionId={null} />);
  const trigger = screen.getByRole("button", { name: "セッションIDを確認" }) as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
  expect(trigger.textContent).toBe("ID");
  expect(trigger.title).toContain("まだ発行されていない");
});

it("closes the old dialog when the session ID changes", () => {
  const view = render(<SessionIdButton sessionId={sessionId} />);
  fireEvent.click(screen.getByRole("button", { name: "セッションIDを確認" }));
  view.rerender(<SessionIdButton sessionId="another-session" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "セッションIDを確認" }));
  expect((screen.getByRole("textbox", { name: "完全なセッションID" }) as HTMLInputElement).value).toBe("another-session");
});
