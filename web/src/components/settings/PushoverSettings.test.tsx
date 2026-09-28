// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushoverSettings } from "./PushoverSettings";

const mocks = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson: mocks.get, sendJson: mocks.send }));

const configured = {
  hasToken: true, hasUser: true, device: "",
  envManaged: { token: false, user: false, device: false },
};

beforeEach(() => {
  mocks.get.mockResolvedValue(configured);
  mocks.send.mockResolvedValue(configured);
});
afterEach(() => {
  cleanup();
  mocks.get.mockReset();
  mocks.send.mockReset();
});

describe("PushoverSettings", () => {
  it("loads credential presence without rendering or fetching secret values", async () => {
    render(<PushoverSettings />);
    expect((await screen.findAllByText("設定済み")).length).toBeGreaterThan(0);
    expect(mocks.get).toHaveBeenCalledWith("/api/pushover", undefined, { coalesce: false });
    expect((screen.getByLabelText("アプリ/APIトークン") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("アプリ/APIトークン") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("User Key") as HTMLInputElement).value).toBe("");
  });

  it("saves new keys, then clears input values; test button sends only after saved", async () => {
    render(<PushoverSettings />);
    const field = await screen.findByLabelText("アプリ/APIトークン");
    fireEvent.change(field, { target: { value: "token123" } });
    expect(screen.getByRole("button", { name: "テスト通知" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/pushover", { token: "token123" }, "PUT"));
    await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "テスト通知" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/pushover", undefined, "POST", { timeoutMs: 10_000 }));
  });

  it("requires explicit save to delete a key and offers undo", async () => {
    render(<PushoverSettings />);
    await screen.findByLabelText("User Key");
    const deleteButtons = screen.getAllByRole("button", { name: "削除" });
    fireEvent.click(deleteButtons[0]!);
    expect(screen.getByText("削除予定")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("削除予定")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "削除" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/pushover", { token: null }, "PUT"));
  });

  it("disables environment-managed fields while permitting device changes", async () => {
    mocks.get.mockResolvedValue({ ...configured, envManaged: { token: true, user: true, device: false } });
    render(<PushoverSettings />);
    const token = await screen.findByLabelText("アプリ/APIトークン");
    expect((token as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("User Key") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    fireEvent.change(screen.getByLabelText("送信先デバイス（任意）"), { target: { value: "iphone" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("/api/pushover", { device: "iphone" }, "PUT"));
  });
});
