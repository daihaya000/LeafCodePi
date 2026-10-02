// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./QuestionCard";
import type { QuestionRequestDto } from "@/lib/types";

function request(id: string, question = "選択してください"): QuestionRequestDto {
  return {
    id,
    sessionId: "session-1",
    questions: [
      {
        header: "確認",
        question,
        options: [{ label: "はい" }, { label: "いいえ" }],
        multiple: false,
        custom: false,
      },
    ],
  };
}

describe("QuestionCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not submit custom input when Enter confirms IME composition", async () => {
    const current = request("q-ime");
    current.questions[0]!.custom = true;
    const onReply = vi.fn(async () => undefined);
    render(<QuestionCard request={current} onReply={onReply} onReject={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "回答" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onReply).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onReply).toHaveBeenCalledWith(current, [["回答"]]));
  });

  it("ignores stale reply completion after the request id changes", async () => {
    let resolveReply!: () => void;
    const onReply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReply = resolve;
        }),
    );
    const onReject = vi.fn(async () => undefined);
    const { rerender } = render(
      <QuestionCard request={request("q-1")} onReply={onReply} onReject={onReject} />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "はい" }));
    expect(onReply).toHaveBeenCalledOnce();

    rerender(
      <QuestionCard request={request("q-2", "次の質問")} onReply={onReply} onReject={onReject} />,
    );
    expect(screen.getByText("次の質問")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "キャンセル" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    resolveReply();
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "キャンセル" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps question newlines and scrolls only the body so actions stay reachable", () => {
    const current = request("q-long", "前提\n- 制約1\n- 制約2");
    current.questions[0]!.custom = true;
    render(<QuestionCard request={current} onReply={vi.fn()} onReject={vi.fn()} />);
    const text = screen.getByText((_, el) => el?.tagName === "P" && el.textContent === current.questions[0]!.question);
    expect(text.className).toContain("whitespace-pre-wrap");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.className).toContain("max-h-");
    const body = screen.getByTestId("question-body");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.contains(screen.getByRole("radio", { name: "はい" }))).toBe(true);
    expect(body.contains(screen.getByRole("textbox"))).toBe(false);
    expect(body.contains(screen.getByRole("button", { name: "キャンセル" }))).toBe(false);
  });
});
