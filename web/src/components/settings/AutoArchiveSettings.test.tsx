// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoArchiveSettings } from "./AutoArchiveSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));

const path = "/api/settings/auto-archive-days";

describe("AutoArchiveSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ value: null });
    sendJson.mockResolvedValue({ value: "off" });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("loads the saved period and allows turning auto-archive off", async () => {
    getJson.mockResolvedValue({ value: "14" });
    render(<AutoArchiveSettings />);
    const select = screen.getByRole("combobox", { name: "古いセッションの自動アーカイブ設定" }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("14");

    fireEvent.change(select, { target: { value: "off" } });
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(path, { value: "off" }, "PUT"));
    expect(select.value).toBe("off");
  });

  it("uses 30 days when unset and restores the previous option on save failure", async () => {
    sendJson.mockRejectedValue(new Error("保存できません"));
    render(<AutoArchiveSettings />);
    const select = screen.getByRole("combobox", { name: "古いセッションの自動アーカイブ設定" }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("30");

    fireEvent.change(select, { target: { value: "7" } });
    await waitFor(() => expect(select.value).toBe("30"));
    expect(screen.getByRole("alert").textContent).toContain("保存できません");
  });

  it("does not overwrite an invalid saved option", async () => {
    getJson.mockResolvedValue({ value: "invalid" });
    render(<AutoArchiveSettings />);
    const select = screen.getByRole("combobox", { name: "古いセッションの自動アーカイブ設定" }) as HTMLSelectElement;
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(select.disabled).toBe(true);
    expect(sendJson).not.toHaveBeenCalled();
  });
});
