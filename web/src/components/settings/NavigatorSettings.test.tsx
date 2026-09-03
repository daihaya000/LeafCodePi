// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NavigatorSettings } from "./NavigatorSettings";

describe("NavigatorSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("localStorageにカスタム値があってもサーバー相当レンダーは既定値を表示する", () => {
    localStorage.setItem("webui:scroll-button-opacity", "0.8");

    const html = renderToStaticMarkup(<NavigatorSettings />);

    expect(html).toContain('aria-label="メッセージ移動ボタンの不透明度"');
    expect(html).toContain('value="0.6"');
    expect(html).not.toContain('value="0.8"');
  });

  it("mount後にlocalStorageの保存値を反映する", async () => {
    localStorage.setItem("webui:scroll-button-opacity", "0.8");

    render(<NavigatorSettings />);

    await waitFor(() => {
      expect(
        (screen.getByLabelText("メッセージ移動ボタンの不透明度") as HTMLInputElement).value,
      ).toBe("0.8");
    });
  });
});
