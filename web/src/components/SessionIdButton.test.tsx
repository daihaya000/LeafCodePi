// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionIdButton } from "./SessionIdButton";

const sessionId = "01a0efee-1234-5678-9012-123456789abc";
const writeText = vi.fn();
const execCommand = vi.fn();
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

beforeEach(() => {
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

it("shows a selectable inline Pi ID without a dedicated popup", () => {
  render(<SessionIdButton sessionId={sessionId} />);
  const input = screen.getByRole("textbox", { name: /PiセッションID/ }) as HTMLInputElement;

  expect(input.value).toBe(sessionId);
  expect(input.readOnly).toBe(true);
  expect(input.disabled).toBe(false);
  expect(input.className).toContain("select-text");
  expect(input.title).toContain("クリックでコピー");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("copies the full ID when clicked", async () => {
  render(<SessionIdButton sessionId={sessionId} />);
  fireEvent.click(screen.getByRole("textbox", { name: /PiセッションID/ }));

  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("セッションIDをコピーした"));
  expect(writeText).toHaveBeenCalledWith(sessionId);
  expect(execCommand).not.toHaveBeenCalled();
});

it.each(["rejected", "unavailable"])("falls back to the selectable input when Clipboard API is %s", async (mode) => {
  if (mode === "unavailable") vi.stubGlobal("navigator", {});
  else writeText.mockRejectedValue(new Error("denied"));
  execCommand.mockImplementation(() => {
    const input = screen.getByRole("textbox", { name: /PiセッションID/ }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(sessionId.length);
    expect(input.value).toBe(sessionId);
    return true;
  });
  render(<SessionIdButton sessionId={sessionId} />);
  fireEvent.click(screen.getByRole("textbox", { name: /PiセッションID/ }));

  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("セッションIDをコピーした"));
  expect(execCommand).toHaveBeenCalledWith("copy");
});

it.each(["false", "throw"])("reports when both copy paths fail (%s)", async (mode) => {
  vi.stubGlobal("navigator", {});
  if (mode === "throw") execCommand.mockImplementation(() => { throw new Error("blocked"); });
  else execCommand.mockReturnValue(false);
  render(<SessionIdButton sessionId={sessionId} />);
  fireEvent.click(screen.getByRole("textbox", { name: /PiセッションID/ }));

  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("コピーできなかった"));
});

it("does not substitute the task ID when no session exists", () => {
  render(<SessionIdButton sessionId={null} />);
  const input = screen.getByRole("textbox", { name: /PiセッションID/ }) as HTMLInputElement;
  expect(input.disabled).toBe(true);
  expect(input.value).toBe("未発行");
  expect(input.title).toContain("まだ発行されていない");
});

it("updates the inline ID and copies the new value", async () => {
  const view = render(<SessionIdButton sessionId={sessionId} />);
  view.rerender(<SessionIdButton sessionId="another-session" />);
  const input = screen.getByRole("textbox", { name: /PiセッションID/ }) as HTMLInputElement;
  expect(input.value).toBe("another-session");
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(input);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("another-session"));
});
