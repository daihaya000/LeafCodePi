// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyImagePart } from "./LazyImagePart";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LazyImagePart", () => {
  it("renders the existing url without fetching anything", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <LazyImagePart
        taskId="task-1"
        messageId="u1"
        partId="u1:image"
        url="data:image/png;base64,AAA"
        alt="shot.png"
        className="c"
      />,
    );

    expect(screen.getByRole("img")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches the single part when the history page shipped an empty url", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const fetchMock = vi.fn(async (_url: string) => new Response(blob, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:restored", revokeObjectURL: () => undefined }));
    render(
      <LazyImagePart
        taskId="task-1"
        messageId="u1"
        partId="u1:image"
        url=""
        alt="shot.png"
        className="c"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /画像を読み込む/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const requested = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(requested).toContain("/api/tasks/task-1/message-image");
    expect(requested).toContain("messageId=u1");
    expect(requested).toContain("partId=u1%3Aimage");
    await waitFor(() => expect(screen.getByRole("img")).toBeTruthy());
    expect(screen.getByRole("img").getAttribute("src")).toBe("blob:restored");
  });

  it("reports a failed refetch instead of retrying forever", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <LazyImagePart taskId="task-1" messageId="u1" partId="u1:image" url="" alt="shot.png" className="c" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /画像を読み込む/ }));

    await waitFor(() => expect(screen.getByText(/画像を読み込めませんでした/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
