// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthPanel } from "./ProviderAuthPanel";

const response = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});
const rateWindow = (title: string, usedPercent: number) => ({
  id: title, title, usedPercent, resetsAt: null, windowMinutes: null,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProviderAuthPanel period usage", () => {
  it("keeps each account's windows and credits in its own card", async () => {
    const accounts = ["first", "second"].map((id) => ({
      id, label: id, providers: ["openai-codex"], enabled: true, createdAt: "", updatedAt: "",
    }));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/accounts") return Promise.resolve(response({ accounts }));
      if (path.endsWith("/auth-status")) return Promise.resolve(response({ providers: ["openai-codex"] }));
      if (path === "/api/codexbar/usage") return Promise.resolve(response({ providers: [
        { id: "openai-codex", accountId: "first", usedPercent: 72, windows: [rateWindow("5時間", 12), rateWindow("週間", 72)], credits: { title: "クレジット", used: null, limit: null, balance: 7 } },
        { id: "openai-codex", accountId: "second", usedPercent: 90, windows: [rateWindow("5時間", 90), rateWindow("週間", 30)], credits: null },
      ] }));
      return Promise.resolve(response({}));
    }));
    render(<ProviderAuthPanel providers={[{
      id: "openai-codex", name: "OpenAI Codex", authenticated: true, oauthAvailable: true,
    }]} onChanged={() => {}} />);

    await screen.findByText("12%");
    const first = screen.getByText("first").closest("li")!;
    const second = screen.getByText("second").closest("li")!;
    expect(within(first).getAllByRole("progressbar").map((bar) => bar.getAttribute("aria-label"))).toEqual(["5時間", "週間"]);
    expect(within(first).getByText("72%")).toBeTruthy();
    expect(within(first).getByText("残高 $7.00")).toBeTruthy();
    expect(within(first).queryByText("90%")).toBeNull();
    expect(within(second).getByText("90%")).toBeTruthy();
    expect(within(second).getByText("30%")).toBeTruthy();
    expect(screen.queryByText("使用量")).toBeNull();
  });

  it("shows period details for shared providers without accounts too", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/codexbar/usage") return Promise.resolve(response({ providers: [{
        id: "synthetic", usedPercent: 65, windows: [rateWindow("日間", 10), rateWindow("月間", 65)],
      }] }));
      return Promise.resolve(response({}));
    }));
    render(<ProviderAuthPanel providers={[{
      id: "synthetic", name: "Synthetic", authenticated: true,
    }]} onChanged={() => {}} />);
    await screen.findByText("10%");
    expect(screen.getByText("65%")).toBeTruthy();
    expect(screen.getAllByRole("progressbar").map((bar) => bar.getAttribute("aria-label"))).toEqual(["日間", "月間"]);
    expect(screen.queryByText("使用量")).toBeNull();
  });
});
