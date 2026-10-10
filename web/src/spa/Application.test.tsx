// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), writer: vi.fn() }));
vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/shell/AutoUpdateActivity", () => ({ AutoUpdateActivity: () => null }));
vi.mock("@/lib/setting-sync", () => ({ ensureServerSettingsHydrated: mocks.settings }));
vi.mock("@/spa/navigation", async () => import("./navigation"));
vi.mock("./ProtectedApp", () => ({ default: () => { useEffect(() => { mocks.writer(); }, []); return <><p>protected UI</p><HostnameLabel /></>; } }));
import { HostnameLabel } from "@/components/shell/HostnameContext";
import { Application } from "./Application";
import { installNavigation } from "./navigation";
import { resetWebUiPresentationForTests } from "./presentation";
const saved = { hostname: "server-host", authFileDisplayPath: "/fixture <display>/webui-auth.json" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => { resetWebUiPresentationForTests(); installNavigation(); history.replaceState(null, "", "/settings"); document.title = "LCP"; mocks.writer.mockReset(); mocks.settings.mockReset().mockResolvedValue(undefined); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { cleanup(); resetWebUiPresentationForTests(); vi.unstubAllGlobals(); });

describe("SPA metadata and saved-settings startup ordering", () => {
  it("admits no settings/default writer before metadata, then waits for saved settings too", async () => {
    const metadata = deferred<Response>(), settings = deferred<void>();
    vi.mocked(fetch).mockReturnValue(metadata.promise); mocks.settings.mockReturnValue(settings.promise);
    render(<Application />); expect(mocks.settings).not.toHaveBeenCalled(); expect(mocks.writer).not.toHaveBeenCalled();
    await act(async () => metadata.resolve(Response.json(saved)));
    await waitFor(() => expect(mocks.settings).toHaveBeenCalledTimes(1)); expect(mocks.writer).not.toHaveBeenCalled();
    await act(async () => settings.resolve(undefined)); await screen.findByText("protected UI");
    expect(mocks.writer).toHaveBeenCalledTimes(1); expect(document.title).toBe("LCP server-host"); expect(screen.getByTitle("server-host")).toBeTruthy();
  });
  it("establishes the server base title before a mounted Sidebar adds unread counts", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(saved));
    mocks.writer.mockImplementation(() => { document.title = `(2) ${document.title}`; });
    render(<Application />); await screen.findByText("protected UI");
    expect(document.title).toBe("(2) LCP server-host");
  });
  it("keeps metadata failures outside default writers, with a visible explicit retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "private dummy" }, { status: 503 })).mockResolvedValueOnce(Response.json(saved));
    render(<Application />); await screen.findByRole("alert"); expect(mocks.writer).not.toHaveBeenCalled(); expect(mocks.settings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("再試行")); await screen.findByText("protected UI"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("removes a Login fragment and signs in exactly once without waiting for metadata", async () => {
    const metadata = deferred<Response>();
    history.replaceState(null, "", "/login?next=%2Fsettings%3Fq%3Dcallback%23models#token=fixture-token");
    vi.mocked(fetch).mockImplementation(url => String(url) === "/webui-bootstrap.json" ? metadata.promise : Promise.resolve(Response.json({ ok: true })));
    render(<Application />); await waitFor(() => expect(location.pathname + location.search + location.hash).toBe("/settings?q=callback#models"));
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/auth/webui")).toHaveLength(1);
    expect(mocks.settings).not.toHaveBeenCalled(); expect(mocks.writer).not.toHaveBeenCalled();
    await act(async () => metadata.resolve(Response.json(saved))); await screen.findByText("protected UI");
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/auth/webui")).toHaveLength(1);
  });
  it("updates Login's escaped display path without resetting typed input or remounting", async () => {
    history.replaceState(null, "", "/login"); const metadata = deferred<Response>(); vi.mocked(fetch).mockReturnValue(metadata.promise);
    render(<Application />); const input = await screen.findByPlaceholderText("起動時に表示されたパスワード"); fireEvent.change(input, { target: { value: "unsent login input" } });
    await act(async () => metadata.resolve(Response.json(saved))); await screen.findByText(saved.authFileDisplayPath);
    expect((input as HTMLInputElement).value).toBe("unsent login input"); expect(document.querySelector("display")).toBeNull(); expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("still redirects a settings 401 with query/hash after public metadata succeeds", async () => {
    history.replaceState(null, "", "/settings?q=saved#models"); vi.mocked(fetch).mockResolvedValue(Response.json(saved)); mocks.settings.mockRejectedValue({ status: 401 });
    render(<Application />); await screen.findByRole("heading", { name: "LeafCodePi にサインイン" });
    expect(location.pathname).toBe("/login"); expect(new URLSearchParams(location.search).get("next")).toBe("/settings?q=saved#models"); expect(mocks.writer).not.toHaveBeenCalled();
  });
});
