// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BotComposer } from "./BotComposer";

afterEach(cleanup);

it("keeps options out of the compact input row and preserves send/stop actions", () => {
  const onSend = vi.fn();
  const onAbort = vi.fn();
  const props = { value: "Hello", onChange: vi.fn(), onKeyDown: vi.fn(), onSend, onAbort, placeholder: "Message", footer: <button>Model options</button> };
  const { getByRole, queryByRole, rerender } = render(<BotComposer {...props} />);
  expect(queryByRole("button", { name: "Model options" })).toBeNull();
  fireEvent.click(getByRole("button", { name: "会話のオプション" }));
  expect(getByRole("button", { name: "Model options" })).toBeTruthy();
  fireEvent.click(getByRole("button", { name: "送信" }));
  expect(onSend).toHaveBeenCalledOnce();
  rerender(<BotComposer {...props} busy />);
  fireEvent.click(getByRole("button", { name: "応答を停止" }));
  expect(onAbort).toHaveBeenCalledOnce();
  expect(getByRole("textbox", { name: "Message" })).toBeTruthy();
});
