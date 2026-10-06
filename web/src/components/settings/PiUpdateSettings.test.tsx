// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_LAUNCH_REQUIRED_HINT_ANY } from "@/lib/host-launch-hints";
import { PiUpdateSettings } from "./PiUpdateSettings";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    defaultVersion: "1.0.0",
    current: "0.99.2",
    pending: null,
    last: null,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PiUpdateSettings", () => {
  it("現在のバージョンと既定バージョンを表示し、予約ボタンを有効化する", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(statusBody()));

    render(<PiUpdateSettings />);

    await waitFor(() => expect(screen.getByText("v0.99.2")).toBeTruthy());
    expect(screen.getByText("v1.0.0")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "既定バージョンに戻す" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "最新版に更新" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("npmに配信中の最新バージョンを確認できる", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(statusBody()))
      .mockResolvedValueOnce(
        jsonResponse({ version: "1.2.3", checkedAt: new Date("2026-10-06T08:00:00Z").getTime() }),
      );

    render(<PiUpdateSettings />);
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "最新版に更新" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "最新バージョンを確認" }));

    await waitFor(() => expect(screen.getByText("v1.2.3")).toBeTruthy());
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/pi/latest-version");
    expect(screen.getByText(/最終確認:/)).toBeTruthy();
  });

  it("最新版への更新を予約して再取得し、予約済みを表示する", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(statusBody()))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, accepted: true, pending: { mode: "latest", requestedAt: 1 } }, 202),
      )
      .mockResolvedValueOnce(
        jsonResponse(statusBody({ pending: { mode: "latest", requestedAt: 1 } })),
      );

    render(<PiUpdateSettings />);
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "最新版に更新" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "最新版に更新" }));

    await waitFor(() => expect(screen.getByText(/予約済み/)).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({ mode: "latest" });
    expect(screen.getByText(/最新版への更新/)).toBeTruthy();
  });

  it("既定バージョンへの再同期を予約できる", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(statusBody({ current: "1.0.4" })))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, accepted: true, pending: { mode: "default", requestedAt: 1 } }, 202),
      )
      .mockResolvedValueOnce(
        jsonResponse(statusBody({ current: "1.0.4", pending: { mode: "default", requestedAt: 1 } })),
      );

    render(<PiUpdateSettings />);
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "既定バージョンに戻す" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "既定バージョンに戻す" }));

    await waitFor(() => expect(screen.getByText(/予約済み/)).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({ mode: "default" });
    expect(screen.getByText(/既定バージョン v1\.0\.0 への再同期/)).toBeTruthy();
  });

  it("前回の更新結果を表示する", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        statusBody({
          last: {
            mode: "latest",
            requestedAt: 1,
            finishedAt: 1_700_000_000_000,
            ok: true,
            updated: true,
            from: "0.99.2",
            version: "1.0.4",
            error: null,
          },
        }),
      ),
    );

    render(<PiUpdateSettings />);

    await waitFor(() => expect(screen.getByText(/v0\.99\.2 → v1\.0\.4/)).toBeTruthy());
    expect(screen.getByText(/成功/)).toBeTruthy();
  });

  it("ホストへ接続できない場合は予約ボタンを無効化する", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "ホスト制御に接続できません: fetch failed" }, 502),
    );

    render(<PiUpdateSettings />);

    await waitFor(() => expect(screen.getByText(HOST_LAUNCH_REQUIRED_HINT_ANY)).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: "最新版に更新" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
