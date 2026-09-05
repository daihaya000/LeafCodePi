// @vitest-environment happy-dom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Composer, type ComposerAttachment } from "./Composer";

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

  it("grows with new lines and removes the blue focus outline", () => {
    const view = render(<TestComposer value="一行目" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 72 });

    view.rerender(<TestComposer value="一行目\n二行目" />);

    expect(textarea.style.height).toBe("72px");
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

  it("opens and closes grouped settings without losing values", async () => {
    render(<SettingsComposer />);

    const trigger = screen.getByRole("button", { name: "タスク設定" });
    const panel = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("region");
    expect(panel?.getAttribute("aria-labelledby")).toBe(trigger.id);

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("heading", { name: "実行設定" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("モデル設定")));
    expect(screen.getByRole("heading", { name: "権限設定" })).toBeTruthy();

    const model = screen.getByLabelText("モデル設定") as HTMLInputElement;
    fireEvent.change(model, { target: { value: "Claude" } });
    model.focus();
    fireEvent.keyDown(model, { key: "Escape" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(model.value).toBe("Claude");
    expect(panel?.className).toContain("hidden");

    fireEvent.click(trigger);
    expect((screen.getByLabelText("モデル設定") as HTMLInputElement).value).toBe("Claude");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
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
});
