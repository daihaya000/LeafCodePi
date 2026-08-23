// @vitest-environment happy-dom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("suggests and highlights slash skill references", () => {
    function ReferenceComposer() {
      const [value, setValue] = useState("");
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Composer
          className=""
          attachments={[]}
          onRemoveAttachment={() => {}}
          references={{
            skills: [{ name: "review", description: "Review changes" }],
            agents: [{ name: "reviewer", description: "Review agent" }],
          }}
          textarea={{
            ref: textareaRef,
            value,
            rows: 1,
            ariaLabel: "メッセージ",
            placeholder: "入力",
            className: "",
            onChange: (event) => setValue(event.target.value),
            onValueChange: setValue,
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

    render(<ReferenceComposer />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.change(textarea, { target: { value: "/skill:r" } });
    expect(screen.getByRole("listbox", { name: "スキル候補" })).toBeTruthy();
    expect(screen.getByRole("option").textContent).toContain("/skill:review");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/skill:review ");
    expect(document.querySelector('[aria-hidden="true"] .text-accent')).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "@rev" } });
    expect(screen.getByRole("listbox", { name: "エージェント候補" })).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("@reviewer ");
    expect(document.querySelector('[aria-hidden="true"] .text-primary')).toBeTruthy();
  });
});
