// @vitest-environment happy-dom
import { StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ComposerAttachment } from "@/components/Composer";
import { saveForkDraft, takeForkDraft } from "@/lib/task-fork";
import { useForkDraft } from "./use-fork-draft";

function Editor({ id }: { id: string }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  useForkDraft(id, setText, setAttachments);
  return <><textarea aria-label="入力" value={text} onChange={(event) => setText(event.target.value)} /><span>{attachments.length}件</span></>;
}
afterEach(() => { cleanup(); sessionStorage.clear(); });

describe("fork draft", () => {
  it("restores text and attachments under StrictMode without overwriting later edits", () => {
    saveForkDraft("strict", { text: "元の発言", images: [], files: [{ uri: "data:text/plain;base64,YQ==", mime: "text/plain", name: "a.txt" }] });
    const view = render(<StrictMode><Editor id="strict" /></StrictMode>);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "入力" });
    expect(input.value).toBe("元の発言");
    expect(screen.getByText("1件")).toBeTruthy();
    fireEvent.change(input, { target: { value: "別パターン" } });
    view.rerender(<StrictMode><Editor id="strict" /></StrictMode>);
    expect(input.value).toBe("別パターン");
    expect(takeForkDraft("strict")).toBeNull();
  });
  it("restores a pending draft from browser storage on navigation/reload", () => {
    sessionStorage.setItem("webui.fork-draft.stored", JSON.stringify({ text: "保存済み", images: [], files: [] }));
    render(<Editor id="stored" />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("保存済み");
    expect(sessionStorage.getItem("webui.fork-draft.stored")).toBeNull();
  });
  it("ignores malformed stored drafts", () => {
    sessionStorage.setItem("webui.fork-draft.bad", '{"text":"x","images":[null],"files":[]}');
    expect(takeForkDraft("bad")).toBeNull();
  });
});
