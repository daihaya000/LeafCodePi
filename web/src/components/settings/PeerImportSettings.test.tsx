// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeerImportSettings } from "./PeerImportSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));

function fill(url = " http://100.64.0.2:3000 ", token = " TOKEN ", label = " main ") {
  fireEvent.change(screen.getByLabelText("共有元のURL"), { target: { value: url } });
  fireEvent.change(screen.getByLabelText("トークン"), { target: { value: token } });
  fireEvent.change(screen.getByLabelText("アカウント名"), { target: { value: label } });
}

beforeEach(() => {
  getJson.mockResolvedValue({ peers: [] });
});

afterEach(() => {
  cleanup();
  getJson.mockReset();
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

  it("lists imported peer accounts with their connection state and deletes with a reload", async () => {
    getJson.mockResolvedValueOnce({ peers: [
      { id: "p1", label: "main", peerUrl: "http://100.64.0.2:3000", providers: ["anthropic"], online: true },
      { id: "p2", label: "old", peerUrl: "http://100.64.0.3:3000", providers: ["openrouter"], online: false },
    ] });
    sendJson.mockResolvedValue({ ok: true });
    render(<PeerImportSettings />);

    expect(await screen.findByText("main")).toBeTruthy();
    expect(screen.getByText("オンライン")).toBeTruthy();
    expect(screen.getByText("オフライン")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "削除" })[1]);
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/accounts/p2", {}, "DELETE"));
    await waitFor(() => expect(screen.queryByText("old")).toBeNull());
  });

  it("shows an empty state when no account has been imported", async () => {
    render(<PeerImportSettings />);
    expect(await screen.findByText("取り込んだアカウントはありません。")).toBeTruthy();
    expect(screen.queryByText("オンライン")).toBeNull();
  });

  it("hides the peer list when the status request fails", async () => {
    getJson.mockRejectedValue(new Error("offline"));
    render(<PeerImportSettings />);
    expect(await screen.findByText("取り込んだアカウントはありません。")).toBeTruthy();
  });
});
