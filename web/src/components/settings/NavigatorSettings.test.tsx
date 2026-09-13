// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(html).toContain('aria-label="新規セッション・Botを新しいペインで開く"');
    expect(html).toContain('aria-checked="false"');
  });

  it("mount後にlocalStorageの保存値を反映する", async () => {
    localStorage.setItem("webui:scroll-button-opacity", "0.8");
    localStorage.setItem("webui:task-pane-prefer-new", "0");

    render(<NavigatorSettings />);

    await waitFor(() => {
      expect(
        (screen.getByLabelText("メッセージ移動ボタンの不透明度") as HTMLInputElement).value,
      ).toBe("0.8");
      expect(
        screen.getByRole("switch", { name: "新規セッション・Botを新しいペインで開く" }).getAttribute("aria-checked"),
      ).toBe("false");
    });
  });

  it("ペイン分割優先の切替をlocalStorageへ保存する", () => {
    render(<NavigatorSettings />);

    const toggle = screen.getByRole("switch", { name: "新規セッション・Botを新しいペインで開く" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(localStorage.getItem("webui:task-pane-prefer-new")).toBe("1");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(localStorage.getItem("webui:task-pane-prefer-new")).toBe("0");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
