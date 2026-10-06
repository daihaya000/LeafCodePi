// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryPageSizeSettings } from "./HistoryPageSizeSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));

const path = "/api/settings/history-page-size";
const label = "履歴の1回あたりの読み込み件数";

describe("HistoryPageSizeSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ value: null });
    sendJson.mockResolvedValue({ value: "300" });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("shows the default when unset and saves the chosen size", async () => {
    render(<HistoryPageSizeSettings />);
    const select = screen.getByRole("combobox", { name: label }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("150");

    fireEvent.change(select, { target: { value: "300" } });
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(path, { value: "300" }, "PUT"));
    expect(select.value).toBe("300");
  });

  it("keeps a saved size that is not a preset and restores it on save failure", async () => {
    getJson.mockResolvedValue({ value: "250" });
    sendJson.mockRejectedValue(new Error("保存できません"));
    render(<HistoryPageSizeSettings />);
    const select = screen.getByRole("combobox", { name: label }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("250");

    fireEvent.change(select, { target: { value: "50" } });
    await waitFor(() => expect(select.value).toBe("250"));
    expect(screen.getByRole("alert").textContent).toContain("保存できません");
  });
});
