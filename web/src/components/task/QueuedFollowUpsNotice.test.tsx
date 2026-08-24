// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueuedFollowUpsNotice } from "./QueuedFollowUpsNotice";

describe("QueuedFollowUpsNotice", () => {
  afterEach(cleanup);

  it("renders queued prompts and removes the selected item", () => {
    const onRemove = vi.fn();
    render(
      <QueuedFollowUpsNotice
        items={[{ id: 1, text: "テストを実行", attachments: [] }]}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText("キュー待ち:")).toBeTruthy();
    expect(screen.getByText("テストを実行")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /キューから削除/ }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
