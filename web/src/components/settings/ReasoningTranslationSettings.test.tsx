// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatTranslationServiceState,
  ReasoningTranslationSettings,
} from "./ReasoningTranslationSettings";

function statusRoute(body: object) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("ReasoningTranslationSettings", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    localStorage.clear();
  });

  it("formats service states", () => {
    expect(formatTranslationServiceState({ state: "ready" })).toBe("準備完了");
    expect(formatTranslationServiceState({ installed: true })).toBe("導入済み（未起動）");
    expect(formatTranslationServiceState(null)).toBe("未導入");
  });

  it("shows the install button when the engine is not installed and starts installation", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/translation/status") return statusRoute({ installed: false });
      if (url === "/api/translation/install" && init?.method === "POST") {
        return new Response(JSON.stringify({ state: "running" }), { status: 202 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ReasoningTranslationSettings />);

    const button = await screen.findByRole("button", { name: "ローカル翻訳を導入" });
    fireEvent.click(button);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/translation/install",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    // 導入開後は進行中メッセージが出て、ボタンは二重実行防止で無効化される。
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("導入中"));
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides the install button once installed", async () => {
    const fetchMock = vi.fn(async () => statusRoute({ state: "ready", installed: true }));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ReasoningTranslationSettings />);

    await waitFor(() => expect(screen.getByText("サービス状態: 準備完了")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "ローカル翻訳を導入" })).toBeNull();
  });
});
