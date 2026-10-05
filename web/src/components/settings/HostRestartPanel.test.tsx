// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_LAUNCH_REQUIRED_HINT_ANY } from "@/lib/host-launch-hints";
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

async function waitForConfirmEnabled() {
  await waitFor(() => {
    expect((screen.getByRole("button", { name: "再起動する" }) as HTMLButtonElement).disabled).toBe(false);
  });
}

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
      expect(screen.getByText(HOST_LAUNCH_REQUIRED_HINT_ANY)).toBeTruthy();
    });
    expect(
      (screen.getByRole("button", { name: "WebUI を再起動" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("トレイホストの再起動ではWebUI再起動イベントを発火してオーバーレイに任せる", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ running: true }))
      .mockResolvedValueOnce(jsonResponse({ active: 0, taskIds: [] }))
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
      expect(screen.getByRole("dialog").textContent).toContain("フロントエンドとバックエンドを再ビルド・再起動");
      await waitForConfirmEnabled();
      fireEvent.click(screen.getByRole("button", { name: "再起動する" }));

      await waitFor(() => expect(restartEvent).toHaveBeenCalled(), { timeout: 3_000 });
      expect(onRestarted).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("leafcode:webui-restart", restartEvent);
    }
  });

  it("バックエンド再起動は /api/backend/status の ready を待ち、WebUI再起動イベントは発火しない", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ running: true }))
      .mockResolvedValueOnce(jsonResponse({ active: 0, taskIds: [] }))
      .mockResolvedValueOnce(jsonResponse({ backend: { ready: true, startedAt: "before" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, target: "backend", accepted: true }, 202))
      .mockResolvedValueOnce(jsonResponse({ backend: { ready: true, startedAt: "before" } }))
      .mockResolvedValueOnce(jsonResponse({ backend: { ready: true, startedAt: "after" } }));
    const restartEvent = vi.fn();
    window.addEventListener("leafcode:webui-restart", restartEvent);
    try {
      const onRestarted = vi.fn();
      render(<HostRestartPanel onRestarted={onRestarted} />);
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "バックエンド（Pi）を再起動" }) as HTMLButtonElement).disabled,
        ).toBe(false);
      });

      fireEvent.click(screen.getByRole("button", { name: "バックエンド（Pi）を再起動" }));
      expect(screen.getByRole("dialog").textContent).toContain("実行中のセッションはすべて終了");
      expect(screen.getByRole("dialog").textContent).toContain("バックエンドを再ビルド・再起動");
      expect(screen.getByRole("dialog").textContent).toContain("ビルド失敗時は前回のビルドで起動");
      await waitForConfirmEnabled();
      fireEvent.click(screen.getByRole("button", { name: "再起動する" }));

      await waitFor(() => expect(onRestarted).toHaveBeenCalled(), { timeout: 5_000 });
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/goal-loop/active");
      expect(JSON.parse(fetchMock.mock.calls[3]?.[1]?.body as string)).toEqual({ target: "backend" });
      const polled = fetchMock.mock.calls.slice(4).map((call) => String(call[0]));
      expect(polled.every((url) => url.startsWith("/api/backend/status"))).toBe(true);
      expect(restartEvent).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("leafcode:webui-restart", restartEvent);
    }
  });

  it("Goal Loop 中の 409 はエラーとして表示しオーバーレイを出さない", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ running: true }))
      // Probe raced the loop start (0 then); the Host's own guard still answers 409.
      .mockResolvedValueOnce(jsonResponse({ active: 0, taskIds: [] }))
      .mockResolvedValueOnce(jsonResponse({ backend: { ready: true, startedAt: "before" } }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "Goal Loop が 1 件実行中のため Backend の再起動を拒否しました。ループを停止・完了してから再試行してください。", blocked: true },
          409,
        ),
      );
    const restartEvent = vi.fn();
    window.addEventListener("leafcode:webui-restart", restartEvent);
    try {
      render(<HostRestartPanel />);
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "バックエンド（Pi）を再起動" }) as HTMLButtonElement).disabled,
        ).toBe(false);
      });
      fireEvent.click(screen.getByRole("button", { name: "バックエンド（Pi）を再起動" }));
      await waitForConfirmEnabled();
      fireEvent.click(screen.getByRole("button", { name: "再起動する" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Goal Loop"));
      expect(restartEvent).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("leafcode:webui-restart", restartEvent);
    }
  });

  it("実行中の Goal Loop は確認ダイアログで先に知らせ、再起動を押せなくする", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ running: true }))
      .mockResolvedValueOnce(jsonResponse({ active: 1, taskIds: ["t1"] }));
    render(<HostRestartPanel />);
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "トレイホストを再起動" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "トレイホストを再起動" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Goal Loop が 1 件実行中"));
    expect((screen.getByRole("button", { name: "再起動する" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]) === "/api/host/restart")).toBe(false);
  });

  it("確認文は最新ソース取得を案内する", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ running: true }));
    render(<HostRestartPanel />);
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "WebUI を再起動" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    expect(screen.getByText(/最初に最新ソースを取得/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "WebUI を再起動" }));
    expect(screen.getByRole("dialog").textContent).toContain("最初に最新ソースを取得");
  });

  it("WebUI再起動はオーバーレイに任せ、同一プロセスの health では成功扱いにしない", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ running: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, target: "webui", accepted: true }, 202))
      .mockResolvedValueOnce(jsonResponse({ engineOk: true, startedAt: 1 }));
    const restartEvent = vi.fn();
    window.addEventListener("leafcode:webui-restart", restartEvent);
    try {
      const onRestarted = vi.fn();
      render(<HostRestartPanel onRestarted={onRestarted} />);
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "WebUI を再起動" }) as HTMLButtonElement).disabled,
        ).toBe(false);
      });

      expect(screen.queryByRole("button", { name: "WebUI を再ビルド" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "WebUI を再起動" }));
      expect(screen.getByRole("dialog").textContent).toContain("フロントエンドを再ビルド・再起動");
      expect(screen.getByRole("dialog").textContent).toContain("ビルド失敗時は前回のビルドで起動");
      fireEvent.click(screen.getByRole("button", { name: "再起動する" }));

      await waitFor(() => expect(restartEvent).toHaveBeenCalled(), { timeout: 3_000 });
      expect(onRestarted).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/host/restart");
      expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({ target: "webui" });
      // Must not keep polling /api/health after handoff (would false-succeed on the live SPA).
      expect(fetchMock.mock.calls.slice(2).every((call) => !String(call[0]).startsWith("/api/health"))).toBe(true);
    } finally {
      window.removeEventListener("leafcode:webui-restart", restartEvent);
    }
  });
});
