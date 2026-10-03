// @vitest-environment happy-dom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { routerReplace, routerRefresh } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
  routerRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, refresh: routerRefresh }),
  useSearchParams: () => new URLSearchParams("next=%2Fsettings"),
}));

import LoginForm from "./LoginForm";

describe("LoginForm fragment sign-in", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    routerReplace.mockReset();
    routerRefresh.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `${window.location.origin}/login#token=fragment-secret`);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", `${window.location.origin}/`);
  });

  it("removes the token fragment before posting it for sign-in", async () => {
    render(<LoginForm authFileDisplayPath="webui-auth.json" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/webui",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "fragment-secret" }),
      }),
    ));
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/settings"));
    expect(routerRefresh).toHaveBeenCalledOnce();
  });
});
