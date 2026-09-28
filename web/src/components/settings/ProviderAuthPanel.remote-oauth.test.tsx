// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthPanel } from "./ProviderAuthPanel";

class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  close() {}
  constructor() { super(); TestEventSource.instances.push(this); }
}
const fetchMock = vi.fn();
const callbackUrl = "http://127.0.0.1:1456/oauth/callback";
const redirect = `${callbackUrl}?code=test-code&state=test-state`;
const providers = [{ id: "openai-codex", name: "OpenAI Codex", authenticated: true, oauthAvailable: true, highlighted: true }];
const account = { id: "account-1", label: "Remote", providers: ["openai-codex"], enabled: true, createdAt: "", updatedAt: "" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  TestEventSource.instances = [];
  vi.stubGlobal("EventSource", TestEventSource);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "open").mockReturnValue(null);
  fetchMock.mockReset().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/accounts")) return Promise.resolve(response({ accounts: [account] }));
    if (url.endsWith("/auth-status")) return Promise.resolve(response({ providers: ["openai-codex"] }));
    if (url.includes("/login") && !url.includes("/answer") && !url.includes("/callback") && init?.method === "POST") {
      return Promise.resolve(response({ sessionId: "session-1" }));
    }
    return Promise.resolve(response({}));
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function start() {
  render(<ProviderAuthPanel providers={providers} onChanged={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "再ログイン" }));
  await waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
}
async function emit(type: string, payload: object) {
  await act(async () => {
    TestEventSource.instances[0].dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ type, ...payload }) }));
  });
}
async function auth() {
  await emit("notify", { event: { type: "auth_url", url: "https://example.test/auth", callbackUrl } });
}

describe("remote provider OAuth", () => {
  it("offers full callback URL paste for providers without a native manual prompt", async () => {
    await start();
    await auth();
    const input = screen.getByRole("textbox", { name: "ログイン後の戻り先URL全体" });
    expect(input.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(input, { target: { value: redirect } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/providers/openai-codex/login/callback"), expect.objectContaining({
        body: JSON.stringify({ input: redirect, sessionId: "session-1" }),
      }),
    ));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(screen.queryByText("ログイン完了")).toBeNull();
    await emit("done", { ok: true });
    expect(screen.getByText("ログイン完了")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("prefers native manual input and passes the complete URL unchanged", async () => {
    await start();
    await auth();
    await emit("prompt", { id: "prompt-1", prompt: { type: "manual_code", message: "Paste code", placeholder: callbackUrl } });
    fireEvent.change(screen.getByRole("textbox", { name: "認証コード / ログイン後の戻り先URL全体" }), { target: { value: redirect } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/providers/openai-codex/login/answer"), expect.objectContaining({
        body: JSON.stringify({ promptId: "prompt-1", value: redirect, sessionId: "session-1" }),
      }),
    ));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/callback"))).toBe(false);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("keeps validation errors retryable", async () => {
    await start();
    await auth();
    fetchMock.mockResolvedValueOnce(response({ error: "戻り先URLが一致しません" }, 400));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("戻り先URLが一致しません"));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("wrong");
    expect((screen.getByRole("button", { name: "送信" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not overwrite completion with a late callback response", async () => {
    await start();
    await auth();
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: redirect } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await emit("done", { ok: true });
    await act(async () => resolve(response({ ok: true })));
    expect(screen.getByText("ログイン完了")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("does not add callback input to device-code or API-key prompts", async () => {
    await start();
    await emit("notify", { event: { type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://example.test/device" } });
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    await emit("prompt", { id: "key", prompt: { type: "secret", message: "API key" } });
    expect(screen.getByLabelText("API key").getAttribute("type")).toBe("password");
  });
});
