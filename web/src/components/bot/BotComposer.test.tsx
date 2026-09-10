// @vitest-environment happy-dom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BotComposer } from "./BotComposer";

afterEach(cleanup);

it("forwards clipboard paste events to the input", () => {
  const onPaste = vi.fn();
  const { getByRole } = render(<BotComposer value="" onChange={vi.fn()} onPaste={onPaste} onKeyDown={vi.fn()} onSend={vi.fn()} placeholder="Message" />);
  fireEvent.paste(getByRole("textbox"), { clipboardData: { items: [] } });
  expect(onPaste).toHaveBeenCalledOnce();
});

it("does not consume Ctrl+Enter while a reference suggestion is open", () => {
  const onKeyDown = vi.fn();
  function ReferenceComposer() {
    const [value, setValue] = useState("");
    return <BotComposer
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onValueChange={setValue}
      onKeyDown={onKeyDown}
      onSend={vi.fn()}
      placeholder="Message"
      references={{ skills: [{ name: "review" }] }}
    />;
  }

  render(<ReferenceComposer />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  input.focus();
  fireEvent.change(input, { target: { value: "/skill:r", selectionStart: 8 } });
  expect(screen.getByRole("listbox", { name: "スキル候補" })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(onKeyDown).toHaveBeenCalledOnce();
  expect(onKeyDown.mock.calls[0]?.[0]).toMatchObject({ key: "Enter", ctrlKey: true });
});

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

it("suggests and inserts a slash skill reference", () => {
  function ReferenceComposer() {
    const [value, setValue] = useState("");
    const inputRef = useRef<HTMLTextAreaElement>(null);
    return <BotComposer
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onValueChange={setValue}
      onKeyDown={vi.fn()}
      onSend={vi.fn()}
      inputRef={inputRef}
      placeholder="Message"
      references={{ skills: [{ name: "review", description: "Review changes" }] }}
    />;
  }

  render(<ReferenceComposer />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  input.focus();
  fireEvent.change(input, { target: { value: "/skill:r", selectionStart: 8 } });
  expect(screen.getByRole("listbox", { name: "スキル候補" })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("/skill:review ");
});

it("does not confirm a suggestion while IME is composing", () => {
  function ReferenceComposer() {
    const [value, setValue] = useState("/skill:r");
    return <BotComposer
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onValueChange={setValue}
      onKeyDown={vi.fn()}
      onSend={vi.fn()}
      placeholder="Message"
      references={{ skills: [{ name: "review", description: "Review changes" }] }}
    />;
  }

  render(<ReferenceComposer />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  input.focus();
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(input.value).toBe("/skill:r");
});

it("inserts an at-agent reference and a Japanese skill name", () => {
  function ReferenceComposer() {
    const [value, setValue] = useState("");
    const inputRef = useRef<HTMLTextAreaElement>(null);
    return <BotComposer
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onValueChange={setValue}
      onKeyDown={vi.fn()}
      onSend={vi.fn()}
      inputRef={inputRef}
      placeholder="Message"
      references={{
        agents: [{ name: "debugger" }],
        skills: [{ name: "レビュー担当" }],
      }}
    />;
  }

  render(<ReferenceComposer />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  input.focus();

  // エージェント参照（@）
  fireEvent.change(input, { target: { value: "@deb", selectionStart: 4 } });
  expect(screen.getByRole("listbox", { name: "エージェント候補" })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("@debugger ");

  // 日本語参照名（非 ASCII 直後の / トークン）
  fireEvent.change(input, { target: { value: "経路/レ", selectionStart: 4 } });
  expect(screen.getByRole("listbox", { name: "スキル候補" })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("経路/レビュー担当 ");
});
