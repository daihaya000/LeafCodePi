// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueuedFollowUpsNotice } from "./QueuedFollowUpsNotice";

describe("QueuedFollowUpsNotice", () => {
  afterEach(cleanup);

  it("renders queued prompts and removes the selected item", () => {
    const onRemove = vi.fn();
    const onSendNow = vi.fn();
    render(
      <QueuedFollowUpsNotice
        items={[{ id: 1, text: "テストを実行", attachments: [] }]}
        onRemove={onRemove}
        onSendNow={onSendNow}
      />,
    );

    expect(screen.getByText("キュー待ち:")).toBeTruthy();
    expect(screen.getByText("テストを実行")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /即時送信/ }));
    expect(onSendNow).toHaveBeenCalledWith(1);
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /キューから削除/ }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it("disables immediate send while keeping removal available", () => {
    const onSendNow = vi.fn();
    const onRemove = vi.fn();
    render(
      <QueuedFollowUpsNotice
        items={[{ id: 2, text: "", attachments: [] }]}
        onSendNow={onSendNow}
        sendNowDisabled
        onRemove={onRemove}
      />,
    );
    const sendNow = screen.getByRole("button", { name: "即時送信: 画像" }) as HTMLButtonElement;
    expect(sendNow.disabled).toBe(true);
    fireEvent.click(sendNow);
    expect(onSendNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "キューから削除: 画像" }));
    expect(onRemove).toHaveBeenCalledWith(2);
  });

  it("explains why the queue is not draining", () => {
    render(
      <QueuedFollowUpsNotice
        items={[{ id: 3, text: "後で", attachments: [] }]}
        onSendNow={vi.fn()}
        onRemove={vi.fn()}
        hint="Goal Loop 中は自動送信されません"
      />,
    );
    expect(screen.getByText("Goal Loop 中は自動送信されません")).toBeTruthy();
  });
});
