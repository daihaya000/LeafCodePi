// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWebUiPresentation, resetWebUiPresentationForTests, useWebUiPresentation } from "./presentation";
const saved = { hostname: "server-host", authFileDisplayPath: "/fixture/webui-auth.json" };
function Harness() { const { presentation, error, retry } = useWebUiPresentation(); return <><p>{presentation?.hostname ?? (error ? "error" : "loading")}</p><button onClick={retry}>retry</button></>; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { resetWebUiPresentationForTests(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { cleanup(); resetWebUiPresentationForTests(); vi.unstubAllGlobals(); });

describe("SPA public presentation admission", () => {
  it("shares the pending request and successful immutable snapshot across mounts", async () => {
    const request = deferred<Response>(); vi.mocked(fetch).mockReturnValue(request.promise);
    const first = ensureWebUiPresentation(), second = ensureWebUiPresentation(); expect(second).toBe(first);
    await act(async () => { render(<Harness />); request.resolve(Response.json(saved)); await first; });
    await screen.findByText("server-host"); cleanup(); render(<Harness />);
    await screen.findByText("server-host"); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/webui-bootstrap.json", expect.objectContaining({ cache: "no-store", credentials: "same-origin", signal: expect.any(AbortSignal) }));
  });
  it.each([401, 403, 503])("holds errors without reading or echoing the %s response body and retries", async status => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "private dummy error" }, { status })).mockResolvedValueOnce(Response.json(saved));
    render(<Harness />); await screen.findByText("error"); expect(screen.queryByText("private dummy error")).toBeNull();
    fireEvent.click(screen.getByText("retry")); await screen.findByText("server-host"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([null, [], "text", {}, { ...saved, token: "dummy" }, { ...saved, hostname: 1 }, { ...saved, hostname: "" }, { ...saved, hostname: "host\n" }, { ...saved, hostname: "x".repeat(256) }, { ...saved, authFileDisplayPath: null }, { ...saved, authFileDisplayPath: "x".repeat(32769) }])("rejects malformed or expanded DTO %j", async value => {
    vi.mocked(fetch).mockResolvedValue(Response.json(value)); await expect(ensureWebUiPresentation()).rejects.toThrow("Invalid WebUI display information");
  });
  it("releases network/timeout failures for a new attempt", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("dummy timeout", "TimeoutError")).mockResolvedValueOnce(Response.json(saved));
    await expect(ensureWebUiPresentation()).rejects.toThrow("dummy timeout");
    await expect(ensureWebUiPresentation()).resolves.toEqual(saved); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("ignores obsolete component updates but lets a new mount join the same pending request", async () => {
    const request = deferred<Response>(); vi.mocked(fetch).mockReturnValue(request.promise);
    render(<Harness />); cleanup(); render(<Harness />);
    await act(async () => request.resolve(Response.json(saved))); await screen.findByText("server-host"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("an old reset request cannot overwrite a newer cached snapshot", async () => {
    const old = deferred<Response>(); vi.mocked(fetch).mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json(saved));
    const request = ensureWebUiPresentation(); resetWebUiPresentationForTests(); await ensureWebUiPresentation();
    old.resolve(Response.json({ ...saved, hostname: "obsolete" })); await request;
    await expect(ensureWebUiPresentation()).resolves.toEqual(saved);
  });
});
