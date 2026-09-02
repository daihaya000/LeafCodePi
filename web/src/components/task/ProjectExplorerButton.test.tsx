// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectExplorerButton } from "./ProjectExplorerButton";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProjectExplorerButton", () => {
  it("ホストPCのWindows制御面へ到達できる場合だけ表示してExplorerを開く", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        controlUrl: "http://127.0.0.1:18775",
        path: "C:\\work\\project",
      }))
      .mockResolvedValueOnce(json({ ok: true, explorer: true }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectExplorerButton projectId="project-1" onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", {
      name: "プロジェクトをエクスプローラーで開く",
    }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:18775/local-client/capabilities",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "http://127.0.0.1:18775/local-client/explorer",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      path: "C:\\work\\project",
    });
  });

  it("リモート端末からloopback制御面へ到達できない場合は表示しない", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        controlUrl: "http://127.0.0.1:18775",
        path: "C:\\work\\project",
      }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectExplorerButton projectId="project-1" onError={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", {
      name: "プロジェクトをエクスプローラーで開く",
    })).toBeNull();
  });

  it("非Windowsホストでは表示しない", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        controlUrl: "http://127.0.0.1:18775",
        path: "/home/user/project",
      }))
      .mockResolvedValueOnce(json({ ok: true, explorer: false }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectExplorerButton projectId="project-1" onError={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", {
      name: "プロジェクトをエクスプローラーで開く",
    })).toBeNull();
  });
});
