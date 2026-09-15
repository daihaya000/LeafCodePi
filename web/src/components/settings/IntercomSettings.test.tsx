// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntercomSettings } from "./IntercomSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("IntercomSettings", () => {
  beforeEach(() => {
    getJson.mockReset();
    sendJson.mockReset();
    getJson.mockResolvedValue({ inboundTrigger: "replies" });
    sendJson.mockResolvedValue({ inboundTrigger: "always" });
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the current policy and saves a changed policy", async () => {
    render(<IntercomSettings />);

    const select = await screen.findByRole("combobox", { name: "Intercom受信の自動起動範囲" });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("replies"));

    fireEvent.change(select, { target: { value: "always" } });

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith(
        "/api/settings/intercom",
        { inboundTrigger: "always" },
        "PATCH",
      );
    });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("always"));
    expect(screen.getByText("保存しました")).toBeTruthy();
  });

  it("rolls back the policy when saving fails", async () => {
    sendJson.mockRejectedValue(new Error("保存失敗"));
    render(<IntercomSettings />);

    const select = await screen.findByRole("combobox", { name: "Intercom受信の自動起動範囲" });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("replies"));
    fireEvent.change(select, { target: { value: "never" } });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("保存失敗"));
    expect((select as HTMLSelectElement).value).toBe("replies");
  });
});
