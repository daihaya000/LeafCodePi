// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerImportSettings } from "./PeerImportSettings";

const { sendJson } = vi.hoisted(() => ({ sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ sendJson }));

function fill(url = " http://100.64.0.2:3000 ", token = " TOKEN ", label = " main ") {
  fireEvent.change(screen.getByLabelText("共有元のURL"), { target: { value: url } });
  fireEvent.change(screen.getByLabelText("トークン"), { target: { value: token } });
  fireEvent.change(screen.getByLabelText("アカウント名"), { target: { value: label } });
}

afterEach(() => {
  cleanup();
  sendJson.mockReset();
});

describe("PeerImportSettings", () => {
  it("keeps the button disabled until every field is filled", () => {
    render(<PeerImportSettings />);
    const button = screen.getByRole("button", { name: "取り込む" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fill();
    expect(button.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("アカウント名"), { target: { value: "  " } });
    expect(button.disabled).toBe(true);
  });

  it("posts trimmed values, clears the token from the form and reports success", async () => {
    sendJson.mockResolvedValue({ account: { label: "main", providers: ["anthropic", "openai-codex"] } });
    const onImported = vi.fn();
    render(<PeerImportSettings onImported={onImported} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/peer-auth/import",
      { peerUrl: "http://100.64.0.2:3000", token: "TOKEN", label: "main" },
      "POST",
    ));
    expect((await screen.findByRole("status")).textContent).toContain("「main」を追加しました（anthropic、openai-codex）");
    expect((screen.getByLabelText("トークン") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("共有元のURL") as HTMLInputElement).value).toBe("");
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("shows the server error, keeps the form for retry and does not report success", async () => {
    sendJson.mockRejectedValue(new Error("could not reach the sharing LCP or the token was rejected"));
    const onImported = vi.fn();
    render(<PeerImportSettings onImported={onImported} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not reach");
    expect((screen.getByLabelText("共有元のURL") as HTMLInputElement).value).toBe(" http://100.64.0.2:3000 ");
    expect(screen.queryByRole("status")).toBeNull();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("renders the token as a password field and never echoes it", () => {
    render(<PeerImportSettings />);
    expect((screen.getByLabelText("トークン") as HTMLInputElement).type).toBe("password");
  });
});
