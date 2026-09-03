// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HangTimeoutSettings } from "./HangTimeoutSettings";

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }));

vi.mock("@/lib/client", () => ({
  getJson,
  sendJson: vi.fn(),
}));

describe("HangTimeoutSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    getJson.mockResolvedValue({ timeoutMs: 5 * 60_000, resumeMode: "same" });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    getJson.mockReset();
  });

  it("localStorageにカスタム値があってもサーバー相当レンダーは既定値を表示する", () => {
    localStorage.setItem("webui:hang-timeout", String(10 * 60_000));
    localStorage.setItem("webui:auto-resume-mode", "continue");

    const html = renderToStaticMarkup(<HangTimeoutSettings />);

    expect(html).toContain('aria-label="ハング判定時間"');
    expect(html).toContain('value="5"');
    expect(html).toContain('value="same" selected=""');
    expect(html).not.toContain('value="10"');
  });

  it("サーバー取得に失敗してもmount後にlocalStorageの保存値を反映する", async () => {
    localStorage.setItem("webui:hang-timeout", String(10 * 60_000));
    localStorage.setItem("webui:auto-resume-mode", "continue");
    getJson.mockRejectedValue(new Error("network error"));

    render(<HangTimeoutSettings />);

    await waitFor(() => {
      expect((screen.getByLabelText("ハング判定時間") as HTMLInputElement).value).toBe("10");
    });
  });
});
