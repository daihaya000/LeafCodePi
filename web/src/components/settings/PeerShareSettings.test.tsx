// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeerShareSettings } from "./PeerShareSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));

const grant = { id: "g1", label: "laptop", accountId: null, providers: ["anthropic"], createdAt: "2026-10-03T00:00:00Z" };
const providers = { providers: [
  { id: "anthropic", name: "Anthropic", authenticated: true },
  { id: "openrouter", name: "OpenRouter", authenticated: false },
] };

function serve(snapshot: unknown) {
  getJson.mockImplementation(async (path: string) => (path === "/api/providers" ? providers : snapshot));
}

describe("PeerShareSettings", () => {
  beforeEach(() => serve({ enabled: false, authRequired: true, grants: [] }));
  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("offers only logged-in providers and warns that traffic is unencrypted", async () => {
    render(<PeerShareSettings />);
    expect(await screen.findByLabelText("Anthropic")).toBeTruthy();
    expect(screen.queryByLabelText("OpenRouter")).toBeNull();
    expect(screen.getByText(/暗号化されずに流れます/)).toBeTruthy();
  });

  it("creates a grant, shows the token once, and never renders it again after closing", async () => {
    const token = "T".repeat(43);
    sendJson.mockResolvedValue({ grant, token });
    render(<PeerShareSettings />);
    fireEvent.change(await screen.findByLabelText("共有先の名前"), { target: { value: " laptop " } });
    const add = screen.getByRole("button", { name: "共有先を追加" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Anthropic"));
    expect(add.disabled).toBe(false);
    serve({ enabled: false, authRequired: true, grants: [grant] });
    fireEvent.click(add);
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/peer-auth/peers", { label: "laptop", providers: ["anthropic"] }, "POST"));
    expect((await screen.findByTestId("peer-token")).textContent).toBe(token);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByText(token)).toBeNull();
    expect(screen.getByText("laptop")).toBeTruthy();
  });

  it("revokes a grant by id", async () => {
    serve({ enabled: true, authRequired: true, grants: [grant] });
    sendJson.mockResolvedValue({ enabled: true, authRequired: true, grants: [] });
    render(<PeerShareSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "失効" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/peer-auth/peers?id=g1", {}, "DELETE"));
    await waitFor(() => expect(screen.queryByText("laptop")).toBeNull());
  });

  it("toggles sharing through PATCH, and blocks enabling while the WebUI gate is off", async () => {
    sendJson.mockResolvedValue({ enabled: true, authRequired: true, grants: [] });
    render(<PeerShareSettings />);
    const toggle = await screen.findByRole("switch", { name: "認証情報の共有" });
    fireEvent.click(toggle);
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/peer-auth/peers", { enabled: true }, "PATCH"));
    cleanup();

    serve({ enabled: false, authRequired: false, grants: [] });
    render(<PeerShareSettings />);
    const blocked = (await screen.findByRole("switch", { name: "認証情報の共有" })) as HTMLButtonElement;
    await waitFor(() => expect(blocked.disabled || blocked.getAttribute("aria-disabled") === "true").toBe(true));
    expect(screen.getByText(/ゲートを有効にして/)).toBeTruthy();
  });

  it("shows the server's error message", async () => {
    sendJson.mockRejectedValue(new Error("label is invalid"));
    render(<PeerShareSettings />);
    fireEvent.change(await screen.findByLabelText("共有先の名前"), { target: { value: "x" } });
    fireEvent.click(screen.getByLabelText("Anthropic"));
    fireEvent.click(screen.getByRole("button", { name: "共有先を追加" }));
    expect((await screen.findByRole("alert")).textContent).toBe("label is invalid");
  });
});
