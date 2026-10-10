// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", async () => import("./navigation"));
vi.mock("@/components/shell/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/shell/ShellContext", () => ({ ShellProvider: ({ children }: { children: ReactNode }) => children, useShellMobileNav: () => ({ mobileNavOpen: false, closeMobileNav: () => {} }) }));
vi.mock("@/components/shell/TaskPanesContext", () => ({ TaskPanesProvider: ({ children }: { children: ReactNode }) => children, useTaskPanesNavigation: () => ({ mdUp: true }) }));
vi.mock("@/components/shell/GlobalAttentionProvider", () => ({ GlobalAttentionProvider: () => null }));
vi.mock("@/components/task/TaskPanesHost", () => ({ TaskPanesHost: () => <div data-testid="writers-mounted" /> }));
import { AppShell, resetAppShellBootForTests } from "@/components/shell/AppShell";
import { refreshServerSettings, resetServerSettingsHydration } from "@/lib/setting-sync";
import { writeComposerDefaults } from "@/lib/composer-defaults";
import { SettingsGate } from "./SettingsGate";
import { installNavigation } from "./navigation";
const storedDefaults = JSON.stringify({ model: "saved::model", autoOptimize: "cost", agent: "reviewer", thinkingLevel: "high" });
const snapshot = (value = storedDefaults) => new Response(JSON.stringify({ values: { "composer-defaults": value } }), { status: 200 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const shell = () => <SettingsGate><AppShell><div /></AppShell></SettingsGate>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  installNavigation(); window.history.replaceState(null, "", "/task/task-a?q=keep#pane");
  localStorage.clear(); localStorage.setItem("leafcodepi.composerDefaults:server-synced", "1");
  localStorage.setItem("leafcodepi.defaultModel", "untouched");
  resetServerSettingsHydration(); resetAppShellBootForTests();
  fetchMock = vi.fn(async () => snapshot()); vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("SPA settings startup admission", () => {
  it("waits for saved settings before real Composer default writers mount, including StrictMode/remount", async () => {
    const pending = deferred<Response>(); fetchMock.mockImplementation(() => pending.promise);
    const first = render(<StrictMode>{shell()}</StrictMode>);
    expect(screen.queryByTestId("writers-mounted")).toBeNull(); expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("untouched");
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(snapshot()));
    await screen.findByTestId("writers-mounted");
    expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("saved::model");
    expect(localStorage.getItem("webui:auto-optimize")).toBe("cost");
    expect(localStorage.getItem("leafcodepi.defaultAgent")).toBe("reviewer");
    expect(localStorage.getItem("leafcodepi.thinkingLevel")).toBe("high");
    first.unmount(); render(shell()); await screen.findByTestId("writers-mounted");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each(["network", "http", "invalid"])("blocks writers on %s failure and permits explicit retry", async mode => {
    fetchMock.mockImplementationOnce(() => mode === "network" ? Promise.reject(new Error("offline")) : Promise.resolve(mode === "http" ? new Response("{}", { status: 503 }) : new Response('{"values":{"composer-defaults":123}}')));
    render(shell()); await screen.findByRole("alert");
    expect(screen.queryByTestId("writers-mounted")).toBeNull(); expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("untouched");
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    await screen.findByTestId("writers-mounted"); expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("saved::model");
  });
  it("redirects 401 without mounting writers and keeps query/hash in next", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 })); render(shell());
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/task/task-a?q=keep#pane");
    expect(screen.queryByTestId("writers-mounted")).toBeNull(); expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("untouched");
  });
  it("preserves a persisted pending save instead of applying the stale server snapshot", async () => {
    const pending = JSON.stringify({ model: "pending::model", autoOptimize: "balanced", agent: "default" });
    localStorage.setItem("leafcodepi.composerDefaults", pending); localStorage.setItem("leafcodepi.composerDefaults:server-pending", JSON.stringify(pending));
    render(shell()); await screen.findByTestId("writers-mounted");
    expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("pending::model");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/settings/composer-defaults"), expect.objectContaining({ method: "PUT", body: JSON.stringify({ value: pending }) })));
  });
  it("does not undo a local save started while the snapshot is in flight", async () => {
    const pending = deferred<Response>(); fetchMock.mockImplementation((input: RequestInfo | URL) => new URL(String(input)).pathname === "/api/settings" ? pending.promise : Promise.resolve(new Response("{}")));
    render(shell()); writeComposerDefaults({ model: "new::model", autoOptimize: "balanced", agent: "default" });
    await act(async () => pending.resolve(snapshot())); await screen.findByTestId("writers-mounted");
    expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("new::model");
  });
  it("never reapplies an older snapshot after a newer refresh resolves first", async () => {
    const older = deferred<Response>(), newer = deferred<Response>();
    fetchMock.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    render(shell()); const refreshing = refreshServerSettings();
    await act(async () => { newer.resolve(snapshot(storedDefaults.replace("saved::model", "newer::model"))); await refreshing; older.resolve(snapshot()); });
    await screen.findByTestId("writers-mounted"); expect(localStorage.getItem("leafcodepi.defaultModel")).toBe("newer::model");
  });
});
