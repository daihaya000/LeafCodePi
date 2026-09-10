// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRestartPanel } from "./HostRestartPanel";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HostRestartPanel", () => {
  it("接続確認中は再起動ボタンを無効化し、確認完了後に有効化する", async () => {
    let resolveStatus!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveStatus = resolve; }),
    );

    render(<HostRestartPanel />);

    expect(
      (screen.getByRole("button", { name: "WebUI を再起動" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "トレイホストを再起動" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("接続を確認しています…")).toBeTruthy();

    resolveStatus(jsonResponse({ running: true }));

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "WebUI を再起動" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });

  it("ホストへ接続できない場合は再起動ボタンを無効のまま保つ", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "トレイホストへ接続できません" }, 503),
    );

    render(<HostRestartPanel />);

    await waitFor(() => {
      expect(screen.getByText("start.bat（トレイホスト）経由の起動が必要です。")).toBeTruthy();
    });
    expect(
      (screen.getByRole("button", { name: "WebUI を再起動" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("トレイホストの再起動ではWebUI再起動イベントを発火しない", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ running: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, target: "host", accepted: true }, 202))
      .mockResolvedValueOnce(jsonResponse({ engineOk: true, startedAt: 1 }));
    const restartEvent = vi.fn();
    window.addEventListener("leafcode:webui-restart", restartEvent);
    try {
      const onRestarted = vi.fn();
      render(<HostRestartPanel onRestarted={onRestarted} />);
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "トレイホストを再起動" }) as HTMLButtonElement).disabled,
        ).toBe(false);
      });

      fireEvent.click(screen.getByRole("button", { name: "トレイホストを再起動" }));
      fireEvent.click(screen.getByRole("button", { name: "再起動する" }));

      await waitFor(() => expect(onRestarted).toHaveBeenCalled(), { timeout: 3_000 });
      expect(restartEvent).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("leafcode:webui-restart", restartEvent);
    }
  });
});
