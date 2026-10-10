// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Image, Link } from "./primitives";
import { installNavigation, routeParams, useLocation, useParams, usePathname, useRouter, useSearchParams } from "./navigation";
vi.mock("@/spa/navigation", async () => import("./navigation"));
import LoginForm from "../app/login/LoginForm";
function Probe() {
  return <output>{JSON.stringify({ location: useLocation(), path: usePathname(), query: useSearchParams().get("q"), params: useParams() })}</output>;
}
beforeEach(() => { installNavigation(); window.history.replaceState(null, "", "/"); vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("SPA browser navigation", () => {
  it.each(["/", "/settings", "/bots", "/login", "/task/task-a", "/bots/bot-a", "/bots/rooms/room-a"])("supports direct %s, query/hash and replacement", path => {
    window.history.replaceState(null, "", `${path}?q=a%2Fb#anchor`); render(<Probe />);
    expect(screen.getByRole("status").textContent).toContain(`\"path\":\"${path}\"`);
    expect(screen.getByRole("status").textContent).toContain('"query":"a/b"');
    act(() => useRouter().replace(`${path}?q=new#next`, { scroll: false }));
    expect(screen.getByRole("status").textContent).toContain('"query":"new"');
    expect(window.location.hash).toBe("#next");
  });
  it("observes TaskPanes raw history writes and popstate/hashchange", () => {
    render(<Probe />);
    act(() => window.history.pushState({ pane: 1 }, "", "/task/task-b?q=split"));
    expect(screen.getByRole("status").textContent).toContain('"id":"task-b"');
    act(() => { window.history.replaceState(null, "", "/bots/rooms/room-2"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(screen.getByRole("status").textContent).toContain('"roomId":"room-2"');
    act(() => { window.location.hash = "new"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(screen.getByRole("status").textContent).toContain("#new");
  });
  it("intercepts unmodified same-origin links only", () => {
    render(<><Probe /><Link href="/settings?q=link" scroll={false}>settings</Link></>);
    fireEvent.click(screen.getByText("settings"));
    expect(window.location.pathname).toBe("/settings");
    expect(screen.getByRole("status").textContent).toContain('"query":"link"');
    window.history.replaceState(null, "", "/");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, button: 0 });
    screen.getByText("settings").dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
  });
  it("notifies existing hash observers for push/replace only when the fragment changes", () => {
    const observed: HashChangeEvent[] = [];
    const listener = (event: HashChangeEvent) => observed.push(event);
    window.addEventListener("hashchange", listener);
    try {
      const original = window.location.href;
      useRouter().push("/settings#models", { scroll: false });
      useRouter().replace("/settings?q=one#models", { scroll: false });
      useRouter().replace("/settings?q=one#prompts", { scroll: false });
      expect(observed).toHaveLength(2);
      expect(observed[0].oldURL).toBe(original);
      expect(observed[0].newURL).toBe(`${window.location.origin}/settings#models`);
      expect(observed[1].newURL).toBe(`${window.location.origin}/settings?q=one#prompts`);
    } finally { window.removeEventListener("hashchange", listener); }
  });
  it("preserves image dimensions and the transparent alt placeholder style", () => {
    render(<Image src="/icon.svg" alt="icon" width={20} height={20} priority />);
    const image = screen.getByAltText("icon");
    expect(image.getAttribute("width")).toBe("20");
    expect(image.getAttribute("height")).toBe("20");
    expect(image.getAttribute("loading")).toBe("eager");
    expect(image.style.color).toBe("transparent");
  });
  it("rejects external and javascript navigation", () => {
    expect(() => useRouter().replace("https://other.test/")).toThrow("this origin");
    expect(() => useRouter().push("javascript:alert(1)")).toThrow("this origin");
  });
  it("decodes params exactly once and rejects malformed escapes", () => {
    expect(routeParams("/task/a%252Fb")).toEqual({ id: "a%2Fb" });
    expect(routeParams("/task/%bad")).toEqual({});
  });
  it("removes login fragment before POST and preserves the destination", async () => {
    window.history.replaceState(null, "", "/login?next=%2Fsettings%3Ftab%3Dproviders%23oauth#token=fixture-password");
    const fetch = vi.fn(async () => { expect(window.location.hash).toBe(""); return new Response("{}", { status: 200 }); });
    vi.stubGlobal("fetch", fetch); render(<LoginForm authFileDisplayPath="webui-auth.json" />);
    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
    expect(window.location.search).toBe("?tab=providers"); expect(window.location.hash).toBe("#oauth");
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]).toEqual(["/api/auth/webui", expect.objectContaining({ body: '{"token":"fixture-password"}' })]);
  });
});
