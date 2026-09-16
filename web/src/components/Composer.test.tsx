// @vitest-environment happy-dom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composerPromptAttachments, Composer, type ComposerAttachment } from "./Composer";
import { LARGE_PASTE_CHAR_LIMIT, PASTED_TEXT_FILE_NAME } from "@/lib/clipboard-image";

function TestComposer({
  value,
  attachments = [],
}: {
  value: string;
  attachments?: ComposerAttachment[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Composer
      className=""
      attachments={attachments}
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

function SettingsComposer() {
  const [model, setModel] = useState("Auto");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Composer
      className=""
      attachments={[]}
      onRemoveAttachment={() => {}}
      textarea={{
        ref: textareaRef,
        value: "",
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
      settingsGroups={[
        {
          id: "execution",
          label: "実行設定",
          content: (
            <input
              aria-label="モデル設定"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          ),
        },
        {
          id: "permissions",
          label: "権限設定",
          content: <input aria-label="権限設定" value="確認" readOnly />,
        },
      ]}
      action={null}
    />
  );
}

describe("Composer", () => {
  afterEach(cleanup);

  it("separates image and text-file payloads without dropping names", () => {
    expect(composerPromptAttachments([
      { uri: "data:image/png;base64,aW1hZ2U=", mime: "image/png", name: "shot.png" },
      { uri: "data:text/plain;base64,bm90ZXM=", mime: "text/plain", name: "notes.txt" },
    ])).toEqual({
      images: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      files: [{ name: "notes.txt", mimeType: "text/plain", data: "bm90ZXM=" }],
    });
  });

  it("grows with new lines and removes the blue focus outline", () => {
    const view = render(<TestComposer value="一行目" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 72 });

    view.rerender(<TestComposer value="一行目\n二行目" />);

    expect(textarea.style.height).toBe("72px");
    expect(textarea.className).toContain("px-2");
    expect(textarea.className).toContain("focus-visible:outline-none");
    expect(textarea.className).not.toContain("focus-visible:outline-accent");
  });

  it("does not persist a zero height when the textarea has no layout yet", () => {
    const view = render(<TestComposer value="一行目" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 0 });

    view.rerender(<TestComposer value="一行目" />);

    expect(textarea.style.height).not.toBe("0px");
  });

  it("keeps grouped settings in a horizontally scrollable toolbar", () => {
    render(<SettingsComposer />);

    expect(screen.queryByRole("button", { name: "タスク設定" })).toBeNull();
    const toolbar = screen.getByRole("group", { name: "タスク設定" });
    expect(toolbar.className).toContain("overflow-x-auto");
    expect(toolbar.className).toContain("flex-nowrap");
    expect(toolbar.className).not.toContain("sm:flex-wrap");
    expect(toolbar.className).not.toContain("sm:overflow-visible");
    expect(toolbar.querySelector('[class*="border-l"]')).toBeNull();
    expect(screen.getByLabelText("モデル設定")).toBeTruthy();
    expect(screen.getByLabelText("権限設定")).toBeTruthy();

    const model = screen.getByLabelText("モデル設定") as HTMLInputElement;
    fireEvent.change(model, { target: { value: "Claude" } });
    expect(model.value).toBe("Claude");
  });

  it("opens an attached image and closes it with Escape", () => {
    render(
      <TestComposer
        value=""
        attachments={[{ uri: "data:image/png;base64,abc", mime: "image/png", name: "shot.png" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "shot.pngを拡大表示" }));
    expect(screen.getByRole("dialog", { name: "shot.png（拡大表示）" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "shot.png（拡大表示）" })).toBeNull();
  });

  it("turns a large text paste into an attachment instead of filling the Code field", () => {
    const onFilesSelected = vi.fn();
    function PasteComposer() {
      const [value, setValue] = useState("");
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
            onChange: (event) => setValue(event.target.value),
            onValueChange: setValue,
            onKeyDown: () => {},
          }}
          attachmentControl={{
            inputRef,
            onFilesSelected,
            onTrigger: () => {},
            buttonTitle: "ファイルを添付",
          }}
          action={null}
        />
      );
    }

    render(<PasteComposer />);
    const unit = "貼り付けるテキスト";
    const text = unit.repeat(Math.ceil((LARGE_PASTE_CHAR_LIMIT + 1) / unit.length));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [],
        getData: () => text,
      },
    });

    expect(onFilesSelected).toHaveBeenCalledOnce();
    const file = (onFilesSelected.mock.calls[0]?.[0] as FileList)[0];
    expect(file?.name).toBe(PASTED_TEXT_FILE_NAME);
    expect(file?.type).toBe("text/plain");
    expect(textarea.value).toBe("");
  });

  it("restores a text attachment to the Code field", () => {
    const text = "復元する長文";
    function RestoreComposer() {
      const [value, setValue] = useState("");
      const [attachments, setAttachments] = useState<ComposerAttachment[]>([
        {
          uri: `data:text/plain;base64,${Buffer.from(text, "utf8").toString("base64")}`,
          mime: "text/plain",
          name: "pasted-text.txt",
        },
      ]);
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Composer
          className=""
          attachments={attachments}
          onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, position) => position !== index))}
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
            onFilesSelected: () => {},
            onTrigger: () => {},
            buttonTitle: "ファイルを添付",
          }}
          action={null}
        />
      );
    }

    render(<RestoreComposer />);
    fireEvent.click(screen.getByRole("button", { name: "テキストフィールドに表示" }));

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(text);
    expect(screen.queryByRole("button", { name: "テキストフィールドに表示" })).toBeNull();
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
            agents: [{ name: "reviewer", description: "Review agent", tools: ["read", "grep"] }],
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
    const skillOption = screen.getByRole("option");
    expect(skillOption.textContent).toContain("review");
    expect(skillOption.textContent).toContain("Review changes");
    expect(skillOption.textContent).not.toContain("/skill:review");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/skill:review ");
    expect(document.querySelector('[aria-hidden="true"] .text-accent')).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "@rev" } });
    expect(screen.getByRole("listbox", { name: "エージェント候補" })).toBeTruthy();
    const agentOption = screen.getByRole("option");
    expect(agentOption.textContent).toContain("reviewer");
    expect(agentOption.textContent).toContain("Review agent");
    expect(agentOption.textContent).not.toContain("@reviewer");
    expect(agentOption.querySelector('[data-tool-permission="read"]')).not.toBeNull();
    expect(agentOption.querySelector('[data-tool-permission="grep"]')).not.toBeNull();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("@reviewer ");
    expect(document.querySelector('[aria-hidden="true"] .text-primary')).toBeTruthy();
  });

  it("does not confirm a suggestion while IME is composing", () => {
    function ReferenceComposer() {
      const [value, setValue] = useState("/skill:r");
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Composer
          className=""
          attachments={[]}
          onRemoveAttachment={() => {}}
          references={{
            skills: [{ name: "review", description: "Review changes" }],
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
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(textarea.value).toBe("/skill:r");
  });

  it("does not confirm a suggestion on IME keyCode 229 without compositionStart", () => {
    // compositionStart 欠落時も isImeComposingEvent(keyCode 229) で候補確定を抑止する。
    function ReferenceComposer() {
      const [value, setValue] = useState("/skill:r");
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Composer
          className=""
          attachments={[]}
          onRemoveAttachment={() => {}}
          references={{
            skills: [{ name: "review", description: "Review changes" }],
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
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(textarea.value).toBe("/skill:r");
  });

  it("clears stuck composition on blur so suggestion Enter works again", () => {
    // compositionEnd 欠落で composingRef が stuck しても、blur で解除して候補確定可能にする。
    function ReferenceComposer() {
      const [value, setValue] = useState("/skill:r");
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Composer
          className=""
          attachments={[]}
          onRemoveAttachment={() => {}}
          references={{
            skills: [{ name: "review", description: "Review changes" }],
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
    fireEvent.compositionStart(textarea);
    fireEvent.blur(textarea);
    textarea.focus();
    fireEvent.focus(textarea);
    expect(screen.getByRole("listbox", { name: "スキル候補" })).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/skill:review ");
  });

  it("renders an extra attachment control beside the paperclip", () => {
    function ExtraComposer() {
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Composer
          className=""
          attachments={[]}
          onRemoveAttachment={() => {}}
          textarea={{
            ref: textareaRef,
            value: "",
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
            extra: (
              <button type="button" aria-label="プロジェクトのファイルを明示">
                P
              </button>
            ),
          }}
          toolbar={null}
          action={null}
        />
      );
    }

    render(<ExtraComposer />);
    expect(screen.getByRole("button", { name: "画像を添付" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "プロジェクトのファイルを明示" })).toBeTruthy();
  });
});
