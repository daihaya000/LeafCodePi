// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthPanel } from "./ProviderAuthPanel";

class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  close() {}
  constructor() { super(); TestEventSource.instances.push(this); }
}
const fetchMock = vi.fn();
const account = { id: "goat-account", label: "GOAT", providers: ["commandcode"],
  enabled: true, createdAt: "", updatedAt: "" };
const provider = { id: "commandcode", name: "Command Code", authenticated: false,
  oauthAvailable: true, highlighted: true, methods: ["api_key", "oauth"] as ("api_key" | "oauth")[] };
const response = (body: unknown) => Response.json(body);
beforeEach(() => {
  TestEventSource.instances = [];
  vi.stubGlobal("EventSource", TestEventSource);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/accounts")) return Promise.resolve(response({ accounts: [account] }));
    if (url.endsWith("/auth-status")) return Promise.resolve(response({ providers: [] }));
    if (url.includes("/login") && !url.includes("/answer") && init?.method === "POST") {
      return Promise.resolve(response({ sessionId: "login-test" }));
    }
    return Promise.resolve(response({}));
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function emit(type: string, payload: object) {
  await act(async () => {
    TestEventSource.instances[0].dispatchEvent(new MessageEvent(type, {
      data: JSON.stringify({ type, ...payload }),
    }));
  });
}

describe("Command Code API-key input", () => {
  it("offers an account-scoped masked key form alongside browser login", async () => {
    render(<ProviderAuthPanel providers={[provider]} onChanged={() => {}} />);
    const card = (await screen.findByText("GOAT")).closest("li")!;
    expect(within(card).getByRole("button", { name: "ログイン" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "APIキー登録" }));
    await waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/providers/commandcode/login?accountId=goat-account"),
      expect.objectContaining({ body: JSON.stringify({ type: "api_key" }) }),
    );
    await emit("prompt", { id: "key-prompt", prompt: {
      type: "secret", message: "Command Code API key", placeholder: "user_…",
    } });
    const input = within(card).getByLabelText("Command Code API key");
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect((within(card).getByRole("button", { name: "送信" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "test-account-key" } });
    fireEvent.click(within(card).getByRole("button", { name: "送信" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/providers/commandcode/login/answer"),
      expect.objectContaining({ body: JSON.stringify({
        promptId: "key-prompt", value: "test-account-key", sessionId: "login-test",
      }) }),
    ));
    await emit("done", { ok: true });
    expect(within(card).queryByLabelText("Command Code API key")).toBeNull();
    expect(within(card).getByText("ログイン完了")).toBeTruthy();
  });
});
