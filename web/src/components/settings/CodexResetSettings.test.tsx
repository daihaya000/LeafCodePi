// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexResetSettings } from "./CodexResetSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));
const label = "Codex リセット権の自動使用";
const endpoint = "/api/codexbar/providers";

beforeEach(() => {
  getJson.mockReset().mockResolvedValue({ version: "v1" });
  sendJson.mockReset().mockResolvedValue({ codexResetAutoConsume: false, version: "v2" });
});
afterEach(cleanup);

async function readyToggle() {
  const toggle = screen.getByRole("switch", { name: label });
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  return toggle;
}

describe("CodexResetSettings", () => {
  it("defaults to ON when unset", async () => {
    render(<CodexResetSettings />);
    expect((await readyToggle()).getAttribute("aria-checked")).toBe("true");
    expect(getJson).toHaveBeenCalledWith(endpoint);
  });

  it("loads explicit OFF and warns about expiry", async () => {
    getJson.mockResolvedValue({ codexResetAutoConsume: false, version: "v1" });
    render(<CodexResetSettings />);
    expect((await readyToggle()).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/失効する可能性/)).toBeTruthy();
  });

  it("saves OFF then ON with the latest server version", async () => {
    render(<CodexResetSettings />);
    const toggle = await readyToggle();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(sendJson).toHaveBeenLastCalledWith(endpoint, { codexResetAutoConsume: false, version: "v1" }, "PUT");
    sendJson.mockResolvedValue({ codexResetAutoConsume: true, version: "v3" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(sendJson).toHaveBeenLastCalledWith(endpoint, { codexResetAutoConsume: true, version: "v2" }, "PUT");
  });

  it("keeps the confirmed state and displays save errors", async () => {
    sendJson.mockRejectedValue(new Error("保存失敗"));
    render(<CodexResetSettings />);
    fireEvent.click(await readyToggle());
    expect((await screen.findByRole("alert")).textContent).toBe("保存失敗");
    await waitFor(() => expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("does not allow a toggle before loading completes", async () => {
    let resolve!: (data: object) => void;
    getJson.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<CodexResetSettings />);
    const toggle = screen.getByRole("switch");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);
    expect(sendJson).not.toHaveBeenCalled();
    resolve({ version: "v1" });
    await readyToggle();
  });

  it("prevents duplicate saves while a request is pending", async () => {
    let resolve!: (data: object) => void;
    sendJson.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<CodexResetSettings />);
    const toggle = await readyToggle();
    fireEvent.click(toggle);
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);
    expect(sendJson).toHaveBeenCalledOnce();
    resolve({ codexResetAutoConsume: false, version: "v2" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  it("disables the toggle when loading fails", async () => {
    getJson.mockRejectedValue(new Error("取得失敗"));
    render(<CodexResetSettings />);
    expect((await screen.findByRole("alert")).textContent).toBe("取得失敗");
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("does not reload settings after an unmounted save fails", async () => {
    let reject!: (reason: Error) => void;
    sendJson.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const { unmount } = render(<CodexResetSettings />);
    fireEvent.click(await readyToggle());
    unmount();
    await act(async () => { reject(new Error("保存失敗")); });
    expect(getJson).toHaveBeenCalledOnce();
  });

  it("reloads the actual state/version after a conflict", async () => {
    getJson.mockResolvedValueOnce({ version: "v1" }).mockResolvedValueOnce({ codexResetAutoConsume: false, version: "other" });
    sendJson.mockRejectedValueOnce(new Error("設定が他で変更されました")).mockResolvedValueOnce({ codexResetAutoConsume: true, version: "v3" });
    render(<CodexResetSettings />);
    const toggle = await readyToggle();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    await readyToggle();
    fireEvent.click(toggle);
    await waitFor(() => expect(sendJson).toHaveBeenLastCalledWith(endpoint, { codexResetAutoConsume: true, version: "other" }, "PUT"));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });
});
