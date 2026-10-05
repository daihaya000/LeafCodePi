// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRecord } from "@/lib/accounts";
import { ProviderAuthPanel } from "./ProviderAuthPanel";

const providers = [{ id: "openai-codex", name: "OpenAI Codex", authenticated: true, highlighted: true, oauthAvailable: true, accountRoutingMode: "separate" as const }];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let accounts: AccountRecord[];
let available: number;
let failure: boolean;
let peer: boolean;
const fetchMock = vi.fn();
const changed = vi.fn();
const autoLabel = (name: string) => `${name}のリセット権を自動使用`;

beforeEach(() => {
  accounts = [
    { id: "a", label: "Account A", providers: ["openai-codex"], enabled: true, createdAt: "", updatedAt: "" },
    { id: "b", label: "Account B", providers: ["openai-codex"], enabled: true, codexResetAutoConsume: false, createdAt: "", updatedAt: "" },
  ];
  available = 2;
  failure = false;
  peer = false;
  changed.mockReset();
  fetchMock.mockReset().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/accounts") return response({ accounts });
    if (path.endsWith("/auth-status")) return response({ providers: ["openai-codex"], peer: peer && path.includes("/b/") });
    if (path === "/api/codexbar/usage") return response({ providers: accounts.map((account) => ({ id: "openai-codex", accountId: account.id, usedPercent: 70, resetCreditsAvailable: available, credits: { balance: 0, used: null, limit: null, title: "クレジット" } })) });
    if (path === "/api/codexbar/reset-credits") return response({ credits: [] });
    if (path.startsWith("/api/accounts/") && init?.method === "PATCH") {
      if (failure) return response({ error: "保存失敗" }, 500);
      const id = path.split("/").at(-1);
      accounts = accounts.map((account) => account.id === id ? { ...account, ...JSON.parse(String(init.body)) } : account);
      return response({ account: accounts.find((account) => account.id === id) });
    }
    return response({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function toggle(name = "Account A") {
  const control = await screen.findByRole("switch", { name: autoLabel(name) });
  await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
  return control;
}

function mount() { return render(<ProviderAuthPanel providers={providers} onChanged={changed} />); }

describe("per-account Codex automatic reset toggle", () => {
  it("defaults ON and displays the saved OFF beside reset credits on each account card", async () => {
    mount();
    const a = await toggle();
    expect(a.getAttribute("aria-checked")).toBe("true");
    expect((await toggle("Account B")).getAttribute("aria-checked")).toBe("false");
    const card = a.closest("li")!;
    expect(within(card).getByText("リセット権")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Codex の使用量リセット権を使う" })).toBeTruthy();
    expect(within(card).getByRole("switch", { name: "Account Aを使用" }).getAttribute("aria-checked")).toBe("true");
  });

  it("saves only the chosen account, preserves routing enablement and reloads the saved value", async () => {
    accounts[1].codexResetAutoConsume = true;
    const view = mount();
    fireEvent.click(await toggle());
    await waitFor(() => expect(screen.getByRole("switch", { name: autoLabel("Account A") }).getAttribute("aria-checked")).toBe("false"));
    expect((await toggle("Account B")).getAttribute("aria-checked")).toBe("true");
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(String(patch?.[0])).toContain("/api/accounts/a");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ codexResetAutoConsume: false });
    expect(accounts.every((account) => account.enabled)).toBe(true);
    view.unmount();
    mount();
    expect((await toggle()).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(await toggle());
    await waitFor(() => expect(screen.getByRole("switch", { name: autoLabel("Account A") }).getAttribute("aria-checked")).toBe("true"));
  });

  it("keeps the preference editable when no credits are available", async () => {
    available = 0;
    mount();
    expect((await toggle()).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Codex の使用量リセット権を使う" })).toBeNull();
  });

  it("keeps the confirmed preference after a failed save", async () => {
    failure = true;
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    mount();
    fireEvent.click(await toggle());
    await waitFor(() => expect(alert).toHaveBeenCalledWith("保存失敗"));
    expect((await toggle()).getAttribute("aria-checked")).toBe("true");
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not offer a local automatic reset toggle for peer-owned accounts", async () => {
    peer = true;
    mount();
    await screen.findByText("別のLCP");
    expect(screen.queryByRole("switch", { name: autoLabel("Account B") })).toBeNull();
    expect(await toggle()).toBeTruthy();
  });
});

function mockClaude(kind: "oauth" | "api_key" = "oauth") {
  accounts = accounts.map((account, index) => ({ ...account, providers: ["anthropic"], anthropicResetAutoConsume: index === 0 }));
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/auth-status")) return response({ providers: ["anthropic"], credentialKinds: { anthropic: kind }, anthropicCookieConfigured: true });
    if (path === "/api/codexbar/usage") return response({ providers: accounts.map((account) => ({ id: "anthropic", accountId: account.id, usedPercent: 90, resetCreditsAvailable: kind === "oauth" ? 2 : 0 })) });
    return base(input, init);
  });
  return [{ ...providers[0], id: "anthropic", name: "Claude" }];
}

describe("Claude per-account automatic reset toggle", () => {
  it("shows the same reset-row switch and saves only the chosen Claude account", async () => {
    render(<ProviderAuthPanel providers={mockClaude()} onChanged={changed} />);
    const a = await toggle();
    expect(a.getAttribute("aria-checked")).toBe("true");
    expect((await toggle("Account B")).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(a);
    await waitFor(() => expect(a.getAttribute("aria-checked")).toBe("false"));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ anthropicResetAutoConsume: false });
    expect(accounts[0].codexResetAutoConsume).toBeUndefined();
    expect(accounts[1].anthropicResetAutoConsume).toBe(false);
  });

  it("does not present subscription reset controls for API-key accounts", async () => {
    render(<ProviderAuthPanel providers={mockClaude("api_key")} onChanged={changed} />);
    await screen.findAllByText("Anthropic Console cookie");
    await waitFor(() => expect(screen.queryByRole("switch", { name: autoLabel("Account A") })).toBeNull());
  });
});
