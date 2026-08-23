// @vitest-environment happy-dom
import { useRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Composer } from "./Composer";

function TestComposer({ value }: { value: string }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Composer
      className=""
      attachments={[]}
      onRemoveAttachment={() => {}}
      textarea={{
        ref: textareaRef,
        value,
        rows: 1,
        ariaLabel: "メッセージ",
        placeholder: "入力",
        className: "",
        onChange: () => {},
        onKeyDown: () => {},
      }}
      attachmentControl={{
        inputRef,
        buttonTitle: "画像を添付",
        onFilesSelected: () => {},
        onTrigger: () => {},
      }}
      toolbar={null}
      action={null}
    />
  );
}

describe("Composer", () => {
  afterEach(cleanup);

  it("grows with new lines and removes the blue focus outline", () => {
    const view = render(<TestComposer value="一行目" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 72 });

    view.rerender(<TestComposer value="一行目\n二行目" />);

    expect(textarea.style.height).toBe("72px");
    expect(textarea.className).toContain("focus-visible:outline-none");
  });
});
