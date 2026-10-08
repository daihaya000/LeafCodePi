// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthPanel } from "./ProviderAuthPanel";

class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  constructor() { super(); TestEventSource.instances.push(this); }
  close() {}
}
const fetchMock = vi.fn();
const account = {
  id: "audit-account", label: "Audit", providers: ["anthropic"],
  enabled: true, createdAt: "", updatedAt: "",
};
const provider = {
  id: "anthropic", name: "Anthropic", authenticated: true, oauthAvailable: true,
  highlighted: true, methods: ["oauth", "api_key"] as ("oauth" | "api_key")[],
};
const response = (body: unknown, status = 200) => Response.json(body, { status });
const authenticatedStatus = {
  providers: ["anthropic"], credentialKinds: { anthropic: "oauth" },
};

beforeEach(() => {
  TestEventSource.instances = [];
  vi.stubGlobal("EventSource", TestEventSource);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function card() {
  return (await screen.findByText(account.label)).closest("li")!;
}

function mockApi(authStatus: () => Promise<Response>) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/accounts")) return Promise.resolve(response({ accounts: [account] }));
    if (url.endsWith("/auth-status")) return authStatus();
    if (url.includes("/login") && init?.method === "POST") return Promise.resolve(response({ sessionId: "audit-login" }));
    return Promise.resolve(response({}));
  });
}

describe("provider authentication UI consistency", () => {
  it("does not show API credit baseline settings for an OAuth account", async () => {
    mockApi(() => Promise.resolve(response(authenticatedStatus)));
    render(<ProviderAuthPanel providers={[provider]} onChanged={() => {}} />);
    const region = await card();
    await within(region).findByText("claude.ai cookie");
    expect(within(region).queryByLabelText(/API 基準残高/)).toBeNull();
  });

  it("does not offer registration or report logged-out state while authentication status is pending", async () => {
    let resolveStatus!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveStatus = resolve; });
    mockApi(() => pending);
    render(<ProviderAuthPanel providers={[provider]} onChanged={() => {}} />);
    const region = await card();
    try {
      expect(within(region).getByText("認証状態を確認中…")).toBeTruthy();
      expect(within(region).queryByText("未ログイン")).toBeNull();
      expect(within(region).queryByRole("button", { name: "APIキー登録" })).toBeNull();
      expect(within(region).queryByRole("button", { name: "ログイン" })).toBeNull();
      expect(within(region).queryByText("Anthropic Console cookie")).toBeNull();
    } finally {
      await act(async () => { resolveStatus(response(authenticatedStatus)); });
    }
    expect(await within(region).findByRole("button", { name: "再ログイン" })).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "APIキー登録" })).toBeNull();
  });

  it("reports status failure without registration actions, and recovers through retry", async () => {
    let fail = true;
    mockApi(() => Promise.resolve(fail
      ? response({ error: "status unavailable" }, 503)
      : response(authenticatedStatus)));
    render(<ProviderAuthPanel providers={[provider]} onChanged={() => {}} />);
    const region = await card();
    expect(await within(region).findByText("認証状態の取得失敗")).toBeTruthy();
    expect(within(region).getByRole("alert").textContent).toContain("status unavailable");
    expect(within(region).queryByText("未ログイン")).toBeNull();
    expect(within(region).queryByRole("button", { name: "ログイン" })).toBeNull();
    expect(within(region).queryByRole("button", { name: "APIキー登録" })).toBeNull();
    expect(within(region).queryByText("Anthropic Console cookie")).toBeNull();
    fail = false;
    fireEvent.click(within(region).getByRole("button", { name: "再取得" }));
    expect(await within(region).findByRole("button", { name: "再ログイン" })).toBeTruthy();
    expect(within(region).queryByText("認証状態の取得失敗")).toBeNull();
    expect(within(region).queryByRole("button", { name: "APIキー登録" })).toBeNull();
  });

  it("uses API-key wording in the selected account's form and completion status", async () => {
    let saved = false;
    mockApi(() => Promise.resolve(response(saved
      ? { providers: ["anthropic"], credentialKinds: { anthropic: "api_key" } }
      : { providers: [], credentialKinds: {} })));
    render(<ProviderAuthPanel providers={[provider]} onChanged={() => {}} />);
    const region = await card();
    fireEvent.click(await within(region).findByRole("button", { name: "APIキー登録" }));
    await waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    expect(within(region).getByRole("region", { name: "Anthropic のAPIキー設定" })).toBeTruthy();
    expect(within(region).getByRole("heading", { name: /Anthropic — APIキー設定/ })).toBeTruthy();
    saved = true;
    await act(async () => {
      TestEventSource.instances[0].dispatchEvent(new MessageEvent("done", {
        data: JSON.stringify({ type: "done", ok: true }),
      }));
    });
    expect(within(region).getByText("APIキー保存完了")).toBeTruthy();
    expect(within(region).queryByText("ログイン完了")).toBeNull();
    expect(await within(region).findByRole("button", { name: "APIキー変更" })).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "ログイン" })).toBeNull();
  });

  it("uses the unified login wording in the OAuth form", async () => {
    mockApi(() => Promise.resolve(response(authenticatedStatus)));
    render(<ProviderAuthPanel providers={[provider]} onChanged={() => {}} />);
    const region = await card();
    fireEvent.click(await within(region).findByRole("button", { name: "再ログイン" }));
    expect(await within(region).findByRole("heading", { name: /Anthropic — ログイン/ })).toBeTruthy();
    expect(within(region).queryByText(/サブスクログイン/)).toBeNull();
  });
});
