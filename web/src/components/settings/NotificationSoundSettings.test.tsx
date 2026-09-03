// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationSoundSettings } from "./NotificationSoundSettings";

const { playAttentionRequiredSound, playSessionCompleteSound, sendJson } =
  vi.hoisted(() => ({
    playAttentionRequiredSound: vi.fn(),
    playSessionCompleteSound: vi.fn(),
    sendJson: vi.fn().mockResolvedValue({ ok: true }),
  }));

vi.mock("@/lib/session-complete-sound", () => ({
  playAttentionRequiredSound,
  playSessionCompleteSound,
}));

vi.mock("@/lib/client", () => ({
  getJson: vi.fn(),
  sendJson,
}));

describe("NotificationSoundSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    playAttentionRequiredSound.mockClear();
    playSessionCompleteSound.mockClear();
    sendJson.mockClear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("localStorageにカスタム値があってもサーバー相当レンダーは既定値を表示し、mount後に保存値を反映する", async () => {
    localStorage.setItem("webui:notification-sound-type", "soft");
    localStorage.setItem("webui:notification-sound-volume", "35");

    // SSR相当（useEffect非実行）は既定値のまま。
    const html = renderToStaticMarkup(<NotificationSoundSettings />);
    expect(html).toContain('value="standard" selected=""');
    expect(html).toContain('aria-valuetext="100%"');

    // hydrate相当（mount後）はlocalStorageの保存値へ切り替わる。
    render(<NotificationSoundSettings />);
    await waitFor(() => {
      expect((screen.getByLabelText("通知音の種類") as HTMLSelectElement).value).toBe("soft");
      expect(screen.getByText("35%")).toBeTruthy();
    });
  });

  it("shows the selectable sound type and volume controls", () => {
    render(<NotificationSoundSettings />);

    expect(screen.getByRole("heading", { name: "通知音" })).toBeTruthy();
    expect(
      (screen.getByLabelText("通知音の種類") as HTMLSelectElement).value,
    ).toBe("standard");
    expect(
      (screen.getByLabelText("通知音の音量") as HTMLInputElement).value,
    ).toBe("100");
    expect(
      (screen.getByLabelText("通知音の音量") as HTMLInputElement).max,
    ).toBe("200");
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("persists sound type and volume changes immediately", () => {
    render(<NotificationSoundSettings />);

    fireEvent.change(screen.getByLabelText("通知音の種類"), {
      target: { value: "soft" },
    });
    fireEvent.change(screen.getByLabelText("通知音の音量"), {
      target: { value: "35" },
    });

    expect(localStorage.getItem("webui:notification-sound-type")).toBe("soft");
    expect(localStorage.getItem("webui:notification-sound-volume")).toBe("35");
    expect(screen.getByText("35%")).toBeTruthy();
  });

  it("disables previews when the volume is zero", () => {
    render(<NotificationSoundSettings />);
    fireEvent.change(screen.getByLabelText("通知音の音量"), {
      target: { value: "0" },
    });

    expect(
      (screen.getByRole("button", { name: "完了音を再生" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "注意音を再生" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/音量が0%/)).toBeTruthy();
  });

  it("plays each preview from an explicit user action", () => {
    render(<NotificationSoundSettings />);

    fireEvent.click(screen.getByRole("button", { name: "完了音を再生" }));
    fireEvent.click(screen.getByRole("button", { name: "注意音を再生" }));

    expect(playSessionCompleteSound).toHaveBeenCalledOnce();
    expect(playAttentionRequiredSound).toHaveBeenCalledOnce();
  });
});
