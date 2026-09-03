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
});
