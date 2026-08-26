// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthPanel } from "./ProviderAuthPanel";

const fetchMock = vi.fn();
let confirmSpy: { mockRestore: () => void } | null = null;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  confirmSpy?.mockRestore();
  confirmSpy = null;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const accounts = [
  {
    id: "acc-1",
    label: "仕事用",
    providers: ["openai-codex"],
    note: "メイン",
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "acc-2",
    label: "個人用",
    providers: ["anthropic"],
    createdAt: "",
    updatedAt: "",
  },
];

function mockAccountsApi() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/accounts")) {
      if (method === "GET") return Promise.resolve(jsonResponse({ accounts }));
      if (method === "POST") return Promise.resolve(jsonResponse({}, 200));
    }
    const statusMatch = url.match(/\/api\/accounts\/(acc-\d+)\/auth-status/);
    if (statusMatch) {
      // acc-1 は Codex 認証済み、acc-2 は未認証の想定
      const providers = statusMatch[1] === "acc-1" ? ["openai-codex"] : [];
      return Promise.resolve(jsonResponse({ providers }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe("ProviderAuthPanel accounts section", () => {
  it("lists registered accounts with provider chips", async () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={[]} onChanged={() => {}} />);

    expect(await screen.findByText("仕事用")).toBeTruthy();
    expect(screen.getByText("個人用")).toBeTruthy();
    expect(screen.getByText("ChatGPT (Codex) 認証済")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("メイン")).toBeTruthy();
  });

  it("creates an account from the form and refreshes the list", async () => {
    mockAccountsApi();
    render(<ProviderAuthPanel providers={[]} onChanged={() => {}} />);
    await screen.findByText("仕事用");

    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    fireEvent.change(screen.getByLabelText("表示名"), { target: { value: "新規アカウント" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Claude/ }));
    fireEvent.click(screen.getByRole("button", { name: "作成" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/api/accounts") && (init?.method ?? "GET") === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        label: "新規アカウント",
        providers: ["anthropic"],
        note: undefined,
      });
    });
  });

  it("deletes after confirmation", async () => {
    mockAccountsApi();
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProviderAuthPanel providers={[]} onChanged={() => {}} />);
    await screen.findByText("仕事用");

    fireEvent.click(screen.getAllByRole("button", { name: "削除" })[0]);

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes("/api/accounts/acc-1") && (init?.method ?? "") === "DELETE",
      );
      expect(del).toBeTruthy();
    });
  });

  it("keeps the account when confirmation is cancelled", async () => {
    mockAccountsApi();
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ProviderAuthPanel providers={[]} onChanged={() => {}} />);
    await screen.findByText("仕事用");

    fireEvent.click(screen.getAllByRole("button", { name: "削除" })[0]);

    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes("/api/accounts/acc-") && (init?.method ?? "") === "DELETE",
      ),
    ).toBe(false);
  });
});
