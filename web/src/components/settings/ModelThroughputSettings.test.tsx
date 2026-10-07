// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelThroughputSettings } from "./ModelThroughputSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));

const path = "/api/settings/model-throughput-window";
const label = "モデル速度の直近計測件数";

describe("ModelThroughputSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ value: null });
    sendJson.mockResolvedValue({ value: "100" });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("loads the default 50 and persists a chosen window", async () => {
    render(<ModelThroughputSettings />);
    const select = screen.getByRole("combobox", { name: label }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(getJson).toHaveBeenCalledWith(path);
    expect(select.value).toBe("50");
    fireEvent.change(select, { target: { value: "100" } });
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(path, { value: "100" }, "PUT"));
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("100");
  });

  it("shows non-preset saved values and rolls back on save failure", async () => {
    getJson.mockResolvedValue({ value: "75" });
    sendJson.mockRejectedValue(new Error("保存できません"));
    render(<ModelThroughputSettings />);
    const select = screen.getByRole("combobox", { name: label }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("75");
    fireEvent.change(select, { target: { value: "50" } });
    await waitFor(() => expect(select.value).toBe("75"));
    expect(screen.getByRole("alert").textContent).toContain("保存できません");
  });

  it("keeps the control disabled and reports a load failure", async () => {
    getJson.mockRejectedValue(new Error("読み込めません"));
    render(<ModelThroughputSettings />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("読み込めません"));
    expect((screen.getByRole("combobox", { name: label }) as HTMLSelectElement).disabled).toBe(true);
    expect(sendJson).not.toHaveBeenCalled();
  });
});
