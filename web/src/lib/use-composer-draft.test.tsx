// @vitest-environment happy-dom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useComposerDraft } from "./use-composer-draft";

function Editor({ id }: { id: string }) {
  const { prompt, attachments, setPrompt, setAttachments, clearDraft } = useComposerDraft(id);
  return <>
    <textarea aria-label={id} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
    <span>{attachments.map((item) => item.name).join(",")}</span>
    <button onClick={() => setAttachments((current) => [...current, { uri: "data:text/plain;base64,YQ==", mime: "text/plain", name: "資料.txt" }])}>Attach</button>
    <button onClick={() => setAttachments((current) => current.slice(1))}>Remove</button>
    <button onClick={() => setPrompt((current) => `${current}追記`)}>Append</button>
    <button onClick={clearDraft}>Clear</button>
  </>;
}

afterEach(cleanup);

describe("composer drafts", () => {
  it.each(["task:one", "home", "bot:one", "room:one"])("retains %s text and attachments across remounts under StrictMode", (id) => {
    const view = render(<StrictMode><Editor id={id} /></StrictMode>);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "未送信\n日本語 😀" } });
    fireEvent.click(screen.getByText("Attach"));
    view.unmount();
    render(<StrictMode><Editor id={id} /></StrictMode>);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("未送信\n日本語 😀");
    expect(screen.getByText("資料.txt")).toBeTruthy();
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    cleanup();
    render(<Editor id={id} />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
    expect(screen.queryByText("資料.txt")).toBeNull();
  });

  it("isolates surfaces and restores the correct draft when a view changes keys", () => {
    const view = render(<Editor id="task:one" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "task draft" } });
    fireEvent.click(screen.getByText("Attach"));
    for (const id of ["task:two", "bot:one", "room:one", "home"]) {
      view.rerender(<Editor id={id} />);
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
      expect(screen.queryByText("資料.txt")).toBeNull();
      fireEvent.change(screen.getByRole("textbox"), { target: { value: id } });
    }
    view.rerender(<Editor id="task:one" />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("task draft");
    expect(screen.getByText("資料.txt")).toBeTruthy();
  });

  it("applies functional updates and clears sent drafts without leaving persisted data", () => {
    localStorage.clear(); sessionStorage.clear();
    const view = render(<Editor id="task:one" />);
    fireEvent.click(screen.getByText("Append"));
    fireEvent.click(screen.getByText("Append"));
    fireEvent.click(screen.getByText("Attach"));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("追記追記");
    fireEvent.click(screen.getByText("Clear"));
    view.unmount();
    render(<Editor id="task:one" />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
    expect(screen.queryByText("資料.txt")).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
