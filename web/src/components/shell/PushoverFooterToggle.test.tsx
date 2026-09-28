// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNotificationDeliveryEnabled } from "@/lib/notification-delivery-client";

const mocks = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson: mocks.get, sendJson: mocks.send }));

import { PushoverFooterToggle } from "./PushoverFooterToggle";

beforeEach(() => {
  setNotificationDeliveryEnabled(true);
  mocks.get.mockReset().mockResolvedValue({ enabled: true });
  mocks.send.mockReset().mockResolvedValue({ enabled: false });
});
afterEach(() => {
  cleanup();
  setNotificationDeliveryEnabled(true);
});

describe("shared notification footer toggle", () => {
  it("loads the shared state and persists the OFF/ON selection", async () => {
    render(<PushoverFooterToggle />);
    const off = await screen.findByRole("button", { name: "通知をオフにする（ブラウザ・Pushover）" });
    expect(off.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(off);
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/notifications", { enabled: false }, "PUT"));
    const on = await screen.findByRole("button", { name: "通知をオンにする（ブラウザ・Pushover）" });
    expect(on.getAttribute("aria-pressed")).toBe("false");
    mocks.send.mockResolvedValue({ enabled: true });
    fireEvent.click(on);
    await waitFor(() => expect(screen.getByRole("button", { name: "通知をオフにする（ブラウザ・Pushover）" })).toBeTruthy());
    expect(mocks.send).toHaveBeenLastCalledWith("/api/notifications", { enabled: true }, "PUT");
  });

  it("retains both channels' previous state when saving fails", async () => {
    mocks.send.mockRejectedValue(new Error("保存に失敗"));
    render(<PushoverFooterToggle />);
    fireEvent.click(await screen.findByRole("button", { name: "通知をオフにする（ブラウザ・Pushover）" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "保存に失敗");
    expect(screen.getByRole("button", { name: "通知をオフにする（ブラウザ・Pushover）" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("disables switching when settings cannot be loaded", async () => {
    mocks.get.mockRejectedValue(new Error("unauthorized"));
    render(<PushoverFooterToggle />);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "通知設定を取得できません");
    expect(screen.getByRole("button", { name: "通知の状態を確認中" }).hasAttribute("disabled")).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
