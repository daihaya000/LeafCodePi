// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebUiAuthSettings } from "./WebUiAuthSettings";

const { getJson, sendJson } = vi.hoisted(() => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("WebUiAuthSettings", () => {
  const snapshot = {
    enabled: true,
    remote: true,
    authRequired: true,
    tokenConfigured: true,
    envManaged: false,
  };

  beforeEach(() => {
    getJson.mockResolvedValue(snapshot);
    sendJson.mockResolvedValue({ ...snapshot, enabled: false, authRequired: false });
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("changes the token and gate through the host API without rendering the saved token", async () => {
    render(<WebUiAuthSettings />);

    const gate = await screen.findByRole("switch", { name: "WebUIアクセスゲート" });
    const input = screen.getByLabelText("新しいアクセストークン");
    fireEvent.click(gate);
    fireEvent.change(input, { target: { value: "abcd" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/host/webui-auth",
      { enabled: false, token: "abcd" },
      "POST",
    ));
    expect(screen.queryByText("abcd")).toBeNull();
    expect((await screen.findByRole("status")).textContent).toContain("WebUIを再起動");
  });

  it("does not allow changing an environment-managed token", async () => {
    getJson.mockResolvedValue({ ...snapshot, envManaged: true });
    render(<WebUiAuthSettings />);

    const input = await screen.findByLabelText("新しいアクセストークン");
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/環境変数で指定/)).toBeTruthy();
  });
});
