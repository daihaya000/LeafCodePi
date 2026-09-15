// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...props}>{children}</a>
  ),
}));

import { CodeRequestCard } from "./CodeRequestCard";

afterEach(() => {
  cleanup();
  getJson.mockReset();
  vi.useRealTimers();
});

describe("CodeRequestCard", () => {
  it("loads a terminal task only after its preview is opened", async () => {
    getJson.mockResolvedValue({ task: null });
    const view = render(<CodeRequestCard taskId="task-1" state="delivered" />);

    expect(getJson).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "プレビュー" }));
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(1));
  });

  it("does not overlap preview requests while the current poll is pending", async () => {
    vi.useFakeTimers();
    let resolveRequest!: (value: { task: null }) => void;
    const pendingRequest = new Promise<{ task: null }>((resolve) => {
      resolveRequest = resolve;
    });
    getJson.mockReturnValue(pendingRequest);

    render(<CodeRequestCard taskId="task-1" state="running" />);
    expect(getJson).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getJson).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRequest({ task: null });
      await pendingRequest;
    });
  });
});
