// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeerShareSettings } from "./PeerShareSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));

const grant = { id: "g1", label: "laptop", providers: ["anthropic"], createdAt: "2026-10-03T00:00:00Z" };
const providers = { providers: [
  { id: "anthropic", name: "Anthropic", authenticated: false },
  // Logged in on the default account only: never shared, so never offered.
  { id: "openrouter", name: "OpenRouter", authenticated: true },
  { id: "openai-codex", name: "OpenAI Codex", authenticated: false },
] };
const accounts = { accounts: [
  { id: "acc-1", label: "仕事用", enabled: true },
  { id: "acc-2", label: "停止中", enabled: false },
] };

function serve(snapshot: unknown) {
  getJson.mockImplementation(async (path: string) => {
    if (path === "/api/providers") return providers;
    if (path === "/api/accounts") return accounts;
    if (path.startsWith("/api/accounts/")) {
      const id = decodeURIComponent(path.split("/")[3]);
      return { providers: id === "acc-1" ? ["openai-codex", "anthropic"] : [] };
    }
    return snapshot;
  });
}

describe("PeerShareSettings", () => {
  beforeEach(() => serve({ enabled: false, authRequired: true, grants: [] }));
  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("offers the providers held by added accounts, with account counts, without the unencrypted traffic warning", async () => {
    render(<PeerShareSettings />);
    expect(await screen.findByLabelText(/Anthropic（1アカウント）/)).toBeTruthy();
    expect(screen.getByLabelText(/OpenAI Codex（1アカウント）/)).toBeTruthy();
    // Only the default account holds it (and the disabled account is not counted).
    expect(screen.queryByLabelText(/OpenRouter/)).toBeNull();
    expect(screen.queryByText(/暗号化されずに流れます/)).toBeNull();
  });

  it("creates a provider-scoped grant and shows the token once", async () => {
    const token = "T".repeat(43);
    sendJson.mockResolvedValue({ grant, token });
    render(<PeerShareSettings />);
    fireEvent.change(await screen.findByLabelText("共有先の名前"), { target: { value: " laptop " } });
    const add = screen.getByRole("button", { name: "共有先を追加" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Anthropic/));
    expect(add.disabled).toBe(false);
    serve({ enabled: false, authRequired: true, grants: [grant] });
    fireEvent.click(add);
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith("/api/peer-auth/peers", { label: "laptop", providers: ["anthropic"] }, "POST"));
    expect((await screen.findByTestId("peer-token")).textContent).toBe(token);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByText(token)).toBeNull();
    expect(screen.getByText("laptop")).toBeTruthy();
    expect(screen.getByText("anthropic")).toBeTruthy();
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
    fireEvent.click(screen.getByLabelText(/Anthropic/));
    fireEvent.click(screen.getByRole("button", { name: "共有先を追加" }));
    expect((await screen.findByRole("alert")).textContent).toBe("label is invalid");
  });
});
